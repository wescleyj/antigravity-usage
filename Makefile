UUID = antigravity-usage@wescley.dev
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: test install uninstall enable disable

test:
	gjs -m tests/run_tests.js

install:
	mkdir -p $(HOME)/.local/share/gnome-shell/extensions
	rm -rf $(INSTALL_DIR)
	ln -s $(CURDIR)/src $(INSTALL_DIR)

uninstall:
	rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)
