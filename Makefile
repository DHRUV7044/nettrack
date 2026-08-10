UUID := nettrack@dhruv

.PHONY: enable disable reload status

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

reload:
	gnome-extensions disable $(UUID)
	gnome-extensions enable $(UUID)

status:
	gnome-extensions info $(UUID)