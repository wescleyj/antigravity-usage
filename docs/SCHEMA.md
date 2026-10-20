# Esquema de Dados e Persistência — `antigravity-usage`

## 1. Visão Geral do Armazenamento
Para manter a extensão leve, segura e sem dependências externas pesadas no GNOME Shell, o armazenamento de histórico de uso e preferências do usuário utiliza um arquivo JSON estruturado com permissões restritas (`0700` no diretório, `0600` implícito na escrita atômica via `GLib.file_set_contents`):

- **Caminho Padrão**: `~/.local/share/antigravity-usage/history.json` (respeitando `XDG_DATA_HOME`).
- **Override via Variável de Ambiente (Testes/Dev)**: `ANTIGRAVITY_USAGE_HISTORY_PATH`.

---

## 2. Esquema do Arquivo `history.json` (JSON Schema)

```json
{
  "version": 1,
  "settings": {
    "reloadMode": "auto",
    "autoActiveSec": 180,
    "autoIdleSec": 1800,
    "showPanelPercent": true
  },
  "buckets": {
    "gemini-weekly": [
      {
        "t": 1792509000000,
        "r": 0.98512,
        "resetTime": "2026-10-22T01:17:49Z"
      },
      {
        "t": 1792510800000,
        "r": 0.981133,
        "resetTime": "2026-10-22T01:17:49Z"
      }
    ],
    "gemini-5h": [
      {
        "t": 1792510800000,
        "r": 1.0,
        "resetTime": "2026-10-20T20:19:41Z"
      }
    ],
    "3p-weekly": [
      {
        "t": 1792510800000,
        "r": 0.370778,
        "resetTime": "2026-10-22T22:50:24Z"
      }
    ],
    "3p-5h": [
      {
        "t": 1792510800000,
        "r": 1.0,
        "resetTime": "2026-10-20T20:19:41Z"
      }
    ]
  }
}
```

### 2.1. Definição dos Campos

#### Objeto Raiz
| Campo | Tipo | Obrigatório | Descrição |
| :--- | :--- | :---: | :--- |
| `version` | `number` | Sim | Versão do esquema de persistência (atualmente `1`). |
| `settings` | `UserSettings` | Sim | Preferências de atualização e exibição na barra. |
| `buckets` | `Record<string, QuotaSample[]>` | Sim | Série temporal de amostras indexada pelo `bucketId`. |

#### `UserSettings`
| Campo | Tipo | Padrão | Valores Permitidos | Descrição |
| :--- | :--- | :---: | :--- | :--- |
| `reloadMode` | `"auto" \| number` | `"auto"` | `"auto"`, `60`, `300`, `900`, `1800`, `3600` | Modo de atualização automática ou intervalo fixo em segundos (1m a 1h). |
| `autoActiveSec` | `number` | `180` | `60..3600` | Intervalo (s) no modo `auto` quando o processo `agy` está aberto. |
| `autoIdleSec` | `number` | `1800` | `300..7200` | Intervalo (s) no modo `auto` quando o processo `agy` está fechado. |
| `showPanelPercent` | `boolean` | `true` | `true`, `false` | Define se a porcentagem restante aparece ao lado do ícone na Top Bar. |

#### `QuotaSample`
| Campo | Tipo | Obrigatório | Descrição |
| :--- | :--- | :---: | :--- |
| `t` | `number` | Sim | Timestamp Unix em milissegundos (`Date.now()`). |
| `r` | `number` | Sim | Fração restante da cota no intervalo `[0.0, 1.0]` com precisão de até 6 casas decimais. |
| `resetTime` | `string \| null` | Sim | Timestamp ISO-8601 previsto para o reinício da cota (`resetTime` retornado pela API). |

---

## 3. Regras de Negócio do Histórico e Cálculo de Autonomia (`history.js`)

1. **Deduplicação de Amostras**:
   - Se a variação absoluta `|r_novo - r_anterior| < 0.0001`, o `resetTime` for idêntico e o tempo decorrido desde a última amostra for `< 10 minutos`, a amostra não é duplicada no disco.
2. **Detecção de Reinício de Ciclo (Quota Reset)**:
   - Se `r_novo - r_anterior > 0.02` (aumento superior a 2% na fração disponível), o sistema detecta que a janela de cota reiniciou e limpa as amostras do ciclo anterior daquele `bucketId` para não contaminar o cálculo da taxa média de consumo.
3. **Retenção e Limite de Memória (Pruning)**:
   - Amostras com mais de **8 dias** (`8 * 24 * 3600 * 1000` ms) são descartadas automaticamente.
   - Cada bucket retém no máximo **500 amostras**.
4. **Cálculo Híbrido de Taxa de Consumo (Burn Rate) e Autonomia**:
   - **Taxa Base do Ciclo (`cycleBurnPerHour`)**:
     - Calculada usando `usedFraction = 1 - remainingFraction` dividido pelo tempo já decorrido na janela atual (`windowDuration - (resetTime - now)`), onde `windowDuration` é `168h` para `weekly` e `5h` para `5h`.
   - **Taxa Histórica Recente (`historyBurnPerHour`)**:
     - Calculada quando há $\ge 2$ amostras registradas na janela recente (últimas 6 horas, ou ciclo atual) com $\Delta t \ge 3\text{ min}$ e consumo positivo ($\Delta r = r_{\text{inicial}} - r_{\text{final}} \ge 0$).
   - **Taxa Efetiva (`effectiveBurnPerHour`)**:
     - Se houver tanto `historyBurnPerHour > 0` quanto `cycleBurnPerHour > 0`, combina ambos com média ponderada (`0.65 * historyBurnPerHour + 0.35 * cycleBurnPerHour`). Caso contrário, utiliza a taxa disponível.
   - **Autonomia Estimada (`estimatedDurationMs`)**:
     - $\text{Autonomia (horas)} = \frac{\text{remainingFraction}}{\text{effectiveBurnPerHour}}$.
     - Compara `estimatedDurationMs` com `resetInMs = resetTime - now`:
       - Se `estimatedDurationMs < resetInMs`: alerta que a cota **esgota antes do reset** (`willExhaustBeforeReset = true`).
       - Se `estimatedDurationMs >= resetInMs`: informa que o ritmo atual é **seguro até o reset** (`willExhaustBeforeReset = false`).
