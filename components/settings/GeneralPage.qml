import QtQuick
import qs.Commons
import qs.Ui

// Widget settings stored in the plugin's shell.json entry. Changes apply
// immediately (the shell hot-reloads shell.json).
SettingsPage {
  id: page

  readonly property var service: app.service
  readonly property var s: app.strings

  title: s.t("settings.general.title")
  subtitle: s.t("settings.general.subtitle")

  function set(key, value) {
    if (!service.updateSetting(key, value)) message.text = s.t("settings.general.saveFailed")
  }

  MessageBox {
    id: message
    app: page.app
    error: true
  }

  FieldRow {
    app: page.app
    label: page.s.t("settings.general.initialCount")
    NumberField {
      from: 1
      to: 200
      value: page.service.initialCount
      foreground: page.app.foreground
      accent: page.app.accent
      fontFamily: page.app.fontFamily
      onModified: function(v) { page.set("initialMessageCount", v) }
    }
  }

  FieldRow {
    app: page.app
    label: page.s.t("settings.general.loadMore")
    NumberField {
      from: 1
      to: 200
      value: page.service.loadMoreCount
      foreground: page.app.foreground
      accent: page.app.accent
      fontFamily: page.app.fontFamily
      onModified: function(v) { page.set("loadMoreCount", v) }
    }
  }

  FieldRow {
    app: page.app
    label: page.s.t("settings.general.width")
    NumberField {
      from: 280
      to: 1200
      stepSize: 10
      value: page.service.popupWidth
      foreground: page.app.foreground
      accent: page.app.accent
      fontFamily: page.app.fontFamily
      onModified: function(v) { page.set("popupWidth", v) }
    }
  }

  FieldRow {
    app: page.app
    label: page.s.t("settings.general.height")
    NumberField {
      from: 200
      to: 2000
      stepSize: 10
      value: page.service.popupMaxHeight
      foreground: page.app.foreground
      accent: page.app.accent
      fontFamily: page.app.fontFamily
      onModified: function(v) { page.set("popupMaxHeight", v) }
    }
  }

  Toggle {
    width: parent.width
    label: page.s.t("settings.general.desktop")
    description: page.s.t("settings.general.desktopHint")
    checked: page.service.desktopNotifications
    foreground: page.app.foreground
    accent: page.app.accent
    fontFamily: page.app.fontFamily
    onClicked: page.set("desktopNotifications", !checked)
  }

  Toggle {
    width: parent.width
    label: page.s.t("settings.general.counter")
    checked: page.service.showUnreadCounter
    foreground: page.app.foreground
    accent: page.app.accent
    fontFamily: page.app.fontFamily
    onClicked: page.set("showUnreadCounter", !checked)
  }

  Toggle {
    width: parent.width
    label: page.s.t("settings.general.markRead")
    description: page.s.t("settings.general.markReadHint")
    checked: page.service.markReadOnOpen
    foreground: page.app.foreground
    accent: page.app.accent
    fontFamily: page.app.fontFamily
    onClicked: page.set("markReadOnOpen", !checked)
  }
}
