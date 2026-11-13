import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import ".."

// History size, retention, clear, export and import.
SettingsPage {
  // Esc: cancel the clear confirmation if it is showing.
  function cancelDialog() {
    if (!confirmClear) return false
    confirmClear = false
    return true
  }
  id: page

  readonly property var s: app.strings
  readonly property var service: app.service
  property bool confirmClear: false
  property var exportFiles: []
  property string importChoice: ""
  property string exportDir: ""

  title: s.t("settings.storage.title")
  subtitle: s.t("settings.storage.subtitle")

  function refreshExports() {
    service.request("listExports", {}, function(ok, r) {
      if (!ok) return
      exportDir = r.dir
      exportFiles = r.files
      if (importChoice === "" || exportFiles.indexOf(importChoice) === -1) importChoice = exportFiles.length > 0 ? exportFiles[0] : ""
    })
  }

  Component.onCompleted: refreshExports()

  function show(ok, text) {
    result.error = !ok
    result.text = text
  }

  MessageBox {
    id: result
    app: page.app
  }

  FieldRow {
    app: page.app
    label: page.s.t("settings.storage.stored")
    PlainText {
      topPadding: Style.space(6)
      text: page.s.t("settings.storage.storedValue")
        .arg(Commons.I18n.formatNumber(page.service.total)).arg(Commons.I18n.formatNumber(page.service.unread))
      color: page.app.foreground
      font.family: page.app.fontFamily
      font.pixelSize: Style.font.body
    }
  }

  FieldRow {
    app: page.app
    label: page.s.t("settings.storage.max")
    hint: page.s.t("settings.storage.maxHint")
    NumberField {
      from: 1
      to: 100000
      stepSize: 100
      fieldWidth: Style.space(120)
      value: page.service.maxStored
      foreground: page.app.foreground
      accent: page.app.accent
      fontFamily: page.app.fontFamily
      onModified: function(v) { page.service.updateSetting("maxStoredMessages", v) }
    }
  }

  PanelSectionHeader {
    width: parent.width
    text: page.s.t("settings.storage.manage")
    foreground: page.app.foreground
    fontFamily: page.app.fontFamily
  }

  Row {
    spacing: Style.space(8)

    Button {

      focusable: true
      text: page.s.t("settings.storage.export")
      foreground: page.app.foreground
      accent: page.app.accent
      fontFamily: page.app.fontFamily
      enabled: page.service.total > 0
      onClicked: page.service.request("export", {}, function(ok, r) {
        page.show(ok, ok ? page.s.t("settings.storage.exported").arg(r.count).arg(r.path) : String(r))
        page.refreshExports()
      })
    }

    Button {

      focusable: true
      text: page.s.t("settings.storage.clear")
      foreground: page.app.urgent
      accent: page.app.urgent
      fontFamily: page.app.fontFamily
      enabled: page.service.total > 0
      onClicked: page.confirmClear = true
    }
  }

  FieldRow {
    app: page.app
    label: page.s.t("settings.storage.import")
    hint: page.exportFiles.length > 0 ? page.s.t("settings.storage.importHint") : page.s.t("settings.storage.noExports").arg(page.exportDir)
    Row {
      spacing: Style.space(8)

      Dropdown {
        visible: page.exportFiles.length > 0
        width: Style.space(320)
        showLabel: false
        options: page.exportFiles
        value: page.importChoice
        fontFamily: page.app.fontFamily
        onChanged: function(v) { page.importChoice = v }
      }

      Button {

        focusable: true
        visible: page.exportFiles.length > 0
        text: page.s.t("settings.storage.importButton")
        foreground: page.app.foreground
        accent: page.app.accent
        fontFamily: page.app.fontFamily
        onClicked: page.service.request("import", { path: page.importChoice }, function(ok, r) {
          page.show(ok, ok ? page.s.t("settings.storage.imported").arg(r.imported).arg(r.skipped) : String(r))
        })
      }
    }
  }

  ConfirmDialog {
    parent: page
    anchors.fill: parent
    z: 10
    opened: page.confirmClear
    message: page.s.t("settings.storage.confirmClear")
    confirmText: page.s.t("settings.storage.clear")
    background: page.app.background
    foreground: page.app.foreground
    fontFamily: page.app.fontFamily
    focus: opened
    Keys.onPressed: function(event) { if (handleKey(event)) event.accepted = true }
    onCanceled: page.confirmClear = false
    onConfirmed: {
      page.confirmClear = false
      page.service.clearAll()
      page.show(true, page.s.t("settings.storage.cleared"))
    }
  }
}
