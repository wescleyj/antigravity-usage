# Arquitetura do Sistema — `antigravity-usage`

## 1. Visão Geral
O **`antigravity-usage`** é uma extensão nativa para o **GNOME Shell (versões 45 a 51+)** escrita em **GJS (ESModules)** que exibe um indicador monocromático discreto na barra superior nativa do GNOME (*Top Bar*) e um popup organizado para monitorar em tempo real:
1. **Consumo de cota de tokens do Antigravity CLI (`agy`)** por grupo e por família de modelo (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`).
2. **Percentual usado e restante** nas janelas **Semanal (7 dias)** e **Burst (5 horas)**.
3. **Tempo restante para reinício (Reset Countdown)** de cada janela de cota.
4. **Autonomia estimada (Burn Rate)** calculada a partir do histórico de uso local combinado com a linha de base do ciclo atual, informando quanto tempo a cota restante ainda dura no ritmo médio de uso.
5. **Gerenciamento inteligente de atualização (Smart Reload)** focado em eficiência energética (zero *polling* agressivo), ajustando o intervalo automaticamente conforme o processo `agy` esteja aberto ou fechado, além de seletor manual (`1m` a `1h`) e botão de **Forçar Atualização**.

---

## 2. Arquitetura de Pastas

```text
antigravity-usage/
├── AGENTS.md                        # Diretrizes de Orquestração e TDD
├── docs/
│   ├── ARCHITECTURE.md              # Arquitetura, fluxos e contratos de API
│   └── SCHEMA.md                    # Esquema de persistência (Histórico e Configurações)
├── .env.example                     # Variáveis de ambiente para desenvolvimento/testes
├── Makefile                         # Automação de build, lint, testes e instalação local
├── Dockerfile.test                  # Ambiente containerizado com GJS para CI/testes isolados
├── docker-compose.yml               # Orquestração da suíte de testes
├── src/
│   ├── metadata.json                # Manifesto da extensão GNOME Shell (45–52)
│   ├── extension.js                 # Entrypoint da extensão (PanelMenu.Button + PopupMenu)
│   ├── stylesheet.css               # Estilos St/Clutter (tema escuro/claro, barras e badges)
│   ├── icons/
│   │   └── antigravity-symbolic.svg # Ícone vetorial monocromático (-symbolic) para a Top Bar
│   └── lib/
│       ├── auth.js                  # Leitura segura de token via libsecret (GNOME Keyring) + refresh
│       ├── api.js                   # Cliente HTTP assíncrono (Soup 3.0) para CloudCode API
│       ├── history.js               # Persistência de série temporal, cálculo de Burn Rate e Autonomia
│       ├── processMonitor.js        # Detecção zero-fork do processo `agy` via /proc e leitura de config
│       └── scheduler.js             # Agendador adaptativo (Auto Reload vs Manual 1m–1h)
└── tests/
    ├── run_tests.js                 # Runner de testes unitários em GJS (ESModules)
    ├── history.test.js              # Testes de histórico, burn rate, reset e autonomia
    ├── processMonitor.test.js       # Testes de detecção do CLI e leitura de settings.json
    ├── api.test.js                  # Testes de parsing e mapeamento dos contratos da API
    └── scheduler.test.js            # Testes da máquina de estados de intervalo de reload
```

---

## 3. Contratos de Integração e API

### 3.1. Autenticação Segura (`libsecret` / GNOME Keyring)
O Antigravity CLI (`agy`) armazena suas credenciais OAuth no **GNOME Keyring** sob o schema `org.freedesktop.Secret.Generic`:
- **Atributos de busca**:
  - `service`: `"gemini"`
  - `username`: `"antigravity"`
- **Formato do segredo armazenado**:
  ```json
  {
    "token": {
      "access_token": "ya29...",
      "token_type": "Bearer",
      "refresh_token": "1//...",
      "expiry": "2026-10-20T13:05:54.543148388-03:00"
    },
    "auth_method": "consumer",
    "id_token": "eyJ..."
  }
  ```
- **Fluxo de Renovação (Token Refresh)**:
  - Caso `expiry` esteja expirado (ou faltando `< 60s`) ou a API retorne `HTTP 401`, o módulo `auth.js` aciona de forma assíncrona (`Gio.Subprocess`) `agy models` em background para que o próprio binário oficial atualize o token no Keyring e recarrega o segredo.

### 3.2. Configuração Local do Antigravity CLI
- **Arquivo de configuração**: `~/.gemini/antigravity-cli/settings.json`
  - Campo utilizado: `"model"` (ex: `"Gemini 4 Argon (Medium)"`) para destacar o modelo ativo no popup e na barra superior.
- **Projeto padrão**: `~/.gemini/antigravity-cli/cache/default_project_id.txt` (fallback: `"default-cli-project"`).

### 3.3. Contratos de API HTTP (`cloudcode-pa.googleapis.com`)
Todas as chamadas utilizam `Soup.Session` (Soup 3.0) assíncrono:
- **Headers Obrigatórios**:
  - `Authorization: Bearer <access_token>`
  - `Content-Type: application/json`
  - `User-Agent: antigravity`

#### Endpoint 1: Resumo de Cotas por Grupo e Janela
- **Método / URL**: `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
- **Request Body**:
  ```json
  {
    "project": "default-cli-project"
  }
  ```
- **Response Body (`200 OK`)**:
  ```json
  {
    "groups": [
      {
        "displayName": "Gemini Models",
        "description": "Models within this group: Gemini Flash, Gemini Pro",
        "buckets": [
          {
            "bucketId": "gemini-weekly",
            "displayName": "Weekly Limit Remaining",
            "window": "weekly",
            "resetTime": "2026-10-22T01:17:49Z",
            "remainingFraction": 0.9811328
          },
          {
            "bucketId": "gemini-5h",
            "displayName": "Five Hour Limit Remaining",
            "window": "5h",
            "resetTime": "2026-10-20T20:19:41Z",
            "remainingFraction": 1.0
          }
        ]
      },
      {
        "displayName": "Claude and GPT models",
        "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
        "buckets": [
          {
            "bucketId": "3p-weekly",
            "displayName": "Weekly Limit Remaining",
            "window": "weekly",
            "resetTime": "2026-10-22T22:50:24Z",
            "remainingFraction": 0.3707784
          },
          {
            "bucketId": "3p-5h",
            "displayName": "Five Hour Limit Remaining",
            "window": "5h",
            "resetTime": "2026-10-20T20:19:41Z",
            "remainingFraction": 1.0
          }
        ]
      }
    ]
  }
  ```

#### Endpoint 2: Cota Detalhada por Modelo
- **Método / URL**: `POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`
- **Request Body**:
  ```json
  {
    "project": "default-cli-project"
  }
  ```
- **Response Body (`200 OK`)**:
  ```json
  {
    "models": {
      "claude-opus-5-5-medium": {
        "displayName": "Claude Opus 5.5 (Medium)",
        "quotaInfo": {
          "remainingFraction": 0.3707784,
          "resetTime": "2026-10-22T22:50:24Z"
        }
      },
      "gemini-3.8-flash-tiered": {
        "quotaInfo": {
          "remainingFraction": 1.0,
          "resetTime": "2026-10-20T20:19:42Z"
        }
      }
    }
  }
  ```

---

## 4. Eficiência Energética e Estratégia de Reload (`scheduler.js` & `processMonitor.js`)
1. **Zero Subprocessos para Detecção do CLI**:
   - A verificação se o `agy` está aberto lê diretamente `/proc/<pid>/comm` via `Gio.File` / `GLib.file_get_contents` em memória (< 0.5ms, sem `fork`/`exec`).
2. **Modos de Reload**:
   - **Auto (Inteligente — Padrão)**:
     - `agy` **aberto**: intervalo de atualização de **3 minutos (180s)**.
     - `agy` **fechado**: intervalo reduzido para **30 minutos (1800s)**, evitando tráfego de rede e wakeups desnecessários de CPU.
     - Um *watcher* leve em `/proc` (a cada 60s com `GLib.PRIORITY_DEFAULT_IDLE`) detecta quando o `agy` é aberto para disparar uma atualização imediata e comutar para o intervalo ativo.
   - **Manual**: Opções fixas selecionáveis no popup: `1 min`, `5 min`, `15 min`, `30 min`, `1 hora`.
   - **Forçar Atualização**: Botão dedicado no popup (`↻ Atualizar Agora`) que executa fetch imediato e reinicia o ciclo do timer.
