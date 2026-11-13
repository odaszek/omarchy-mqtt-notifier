import QtQuick
import qs.Commons
import qs.Ui
import ".."

// Add/edit one subscription, including its parser script.
Column {
  id: root

  required property var app
  required property int brokerIndex
  required property int subIndex   // -1 = new
  readonly property var s: app.strings
  readonly property var broker: app.cfg.brokers[brokerIndex]
  readonly property bool isNew: subIndex === -1
  readonly property var original: isNew ? null : broker.subscriptions[subIndex]
  // A parser kept in parsers/<file> is edited in place and written back to that file.
  readonly property string parserFile: !isNew && original.parserFile ? original.parserFile : ""

  property string fTopic: isNew ? "" : original.topic
  property int fQos: isNew ? 0 : original.qos
  property string fDescription: isNew ? "" : original.description
  property bool fEnabled: isNew ? true : original.enabled
  property bool fIgnoreRetained: isNew ? true : original.ignoreRetained
  property var errors: []

  signal finished()

  spacing: Style.space(12)

  function fieldError(name) {
    for (var i = 0; i < errors.length; i++) {
      var p = String(errors[i].path)
      if (p.slice(p.lastIndexOf(".") + 1) === name) return errors[i].message
    }
    return ""
  }

  function save() {
    var brokers = app.brokers()
    var subs = brokers[brokerIndex].subscriptions
    var taken = []
    for (var i = 0; i < subs.length; i++) if (i !== subIndex) taken.push(subs[i].id)
    var sub = {
      id: isNew ? app.uniqueId(fDescription.trim() || fTopic.replace(/[#+]/g, "all"), taken) : original.id,
      topic: fTopic.trim(),
      qos: fQos,
      description: fDescription.trim(),
      enabled: fEnabled,
      ignoreRetained: fIgnoreRetained,
      parserScript: parserFile ? "" : editor.script,
      parserFile: parserFile || null
    }
    if (isNew) subs.push(sub)
    else subs[subIndex] = sub
    var files = {}
    if (parserFile) files[parserFile] = editor.script
    errors = []
    app.saveBrokers(brokers, files, function(ok, errs) {
      if (ok) {
        root.finished()
        return
      }
      var prefix = "brokers[" + brokerIndex + "].subscriptions[" + (isNew ? subs.length - 1 : subIndex) + "]"
      var mine = []
      for (var j = 0; j < errs.length; j++) if (!errs[j].path || String(errs[j].path).indexOf(prefix) === 0) mine.push(errs[j])
      errors = mine.length > 0 ? mine : errs
    })
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.subs.topic")
    hint: root.s.t("settings.subs.topicHint")
    error: root.fieldError("topic")
    TextField {
      width: parent.width
      text: root.fTopic
      placeholderText: "home/garage/#"
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
      onTextEdited: root.fTopic = text
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.subs.qos")
    Dropdown {
      width: Math.min(parent.width, Style.space(320))
      showLabel: false
      options: [
        { value: "0", label: root.s.t("settings.subs.qos0") },
        { value: "1", label: root.s.t("settings.subs.qos1") },
        { value: "2", label: root.s.t("settings.subs.qos2") }
      ]
      value: String(root.fQos)
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.fQos = Number(v) }
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.subs.description")
    hint: root.s.t("settings.subs.descriptionHint")
    TextField {
      width: parent.width
      text: root.fDescription
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
      onTextEdited: root.fDescription = text
    }
  }

  Toggle {
    width: parent.width
    label: root.s.t("settings.subs.enabled")
    checked: root.fEnabled
    foreground: root.app.foreground
    accent: root.app.accent
    fontFamily: root.app.fontFamily
    onClicked: root.fEnabled = !root.fEnabled
  }

  Toggle {
    width: parent.width
    label: root.s.t("settings.subs.ignoreRetained")
    description: root.s.t("settings.subs.ignoreRetainedHint")
    checked: root.fIgnoreRetained
    foreground: root.app.foreground
    accent: root.app.accent
    fontFamily: root.app.fontFamily
    onClicked: root.fIgnoreRetained = !root.fIgnoreRetained
  }

  ParserEditor {
    id: editor
    width: parent.width
    app: root.app
    initialScript: root.parserFile ? (root.app.cfg.parserFiles[root.parserFile] || "") : (root.isNew ? "" : root.original.parserScript)
    fileName: root.parserFile
    error: root.fieldError("parserScript")
  }

  MessageBox {
    app: root.app
    error: true
    text: root.app.errorLines(root.errors)
  }

  Row {
    spacing: Style.space(8)

    Button {

      focusable: true
      text: root.s.t("settings.save")
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      bordered: true
      enabled: !root.app.busy
      onClicked: root.save()
    }

    Button {

      focusable: true
      text: root.s.t("settings.cancel")
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      onClicked: root.finished()
    }
  }
}
