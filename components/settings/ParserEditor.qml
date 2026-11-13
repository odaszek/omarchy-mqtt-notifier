import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import ".."
import "../../lib/format.mjs" as Format

// Parser script editor with a test bench. Tests run in the same sandboxed
// worker as live messages (helper op "testParser") and store nothing.
Column {
  id: root

  required property var app
  property string initialScript: ""
  property string fileName: ""
  property string error: ""
  readonly property string script: code.text
  readonly property var s: app.strings

  property var result: null
  property bool testing: false

  spacing: Style.space(10)

  readonly property string jsonExample: "var data = JSON.parse(msgin)\n"
    + "msgout = \"Temperature: \" + data.temperature + \" °C\"\n"
    + "msgicon = data.temperature > 28 ? ICON_WARN : ICON_OK\n"

  function test() {
    testing = true
    result = null
    app.service.request("testParser", { script: code.text, input: sample.text }, function(ok, r) {
      testing = false
      result = ok ? r : { text: "", icon: null, link: null, fallback: true, error: String(r), warnings: [], logs: [] }
    })
  }

  // Basic editing help: Tab inserts spaces, Enter keeps the indentation.
  // Ctrl+Tab and Shift+Tab leave the editor, so keyboard users are never trapped.
  function handleKey(area, event) {
    if (event.key === Qt.Key_Backtab || (event.key === Qt.Key_Tab && (event.modifiers & Qt.ControlModifier))) {
      var forward = event.key === Qt.Key_Tab
      area.nextItemInFocusChain(forward).forceActiveFocus(forward ? Qt.TabFocusReason : Qt.BacktabFocusReason)
      event.accepted = true
    } else if (event.key === Qt.Key_Tab) {
      area.insert(area.cursorPosition, "  ")
      event.accepted = true
    } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
      var before = area.text.slice(0, area.cursorPosition)
      var line = before.slice(before.lastIndexOf("\n") + 1)
      var indent = /^[ \t]*/.exec(line)[0]
      if (/[{[(]\s*$/.test(line)) indent += "  "
      area.insert(area.cursorPosition, "\n" + indent)
      event.accepted = true
    }
  }

  PanelSectionHeader {
    width: parent.width
    text: root.s.t("settings.parser.title")
    foreground: root.app.foreground
    fontFamily: root.app.fontFamily
  }

  PlainText {
    width: parent.width
    text: root.s.t("settings.parser.help")
    color: root.app.dim
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
    lineHeight: 1.2
  }

  PlainText {
    visible: root.fileName !== ""
    width: parent.width
    text: root.s.t("settings.parser.fromFile").arg(root.fileName)
    color: root.app.accent
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }

  Rectangle {
    width: parent.width
    height: Style.space(220)
    radius: Style.cornerRadius
    color: Util.alpha(root.app.foreground, 0.04)
    border.width: 1
    border.color: code.activeFocus ? root.app.accent : root.app.line

    ScrollView {
      anchors.fill: parent
      anchors.margins: Style.space(2)

      TextArea {
        id: code
        text: root.initialScript
        placeholderText: root.s.t("settings.parser.placeholder")
        textFormat: TextEdit.PlainText
        placeholderTextColor: root.app.dim
        wrapMode: TextEdit.NoWrap
        selectByMouse: true
        persistentSelection: true
        color: root.app.foreground
        selectionColor: Util.alpha(root.app.accent, 0.35)
        font.family: "monospace"
        font.pixelSize: Style.font.body
        background: null
        Keys.onPressed: function(event) { root.handleKey(code, event) }
      }
    }
  }

  PlainText {
    visible: root.error !== ""
    width: parent.width
    text: root.error
    color: root.app.urgent
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.caption
  }

  Row {
    spacing: Style.space(8)

    Button {

      focusable: true
      text: root.s.t("settings.parser.clear")
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      onClicked: code.text = ""
    }

    Button {

      focusable: true
      text: root.s.t("settings.parser.example")
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      onClicked: {
        code.text = root.jsonExample
        if (sample.text === "") sample.text = "{\"temperature\": 29.5, \"humidity\": 65}"
      }
    }
  }

  PlainText {
    width: parent.width
    text: root.s.t("settings.parser.sample")
    color: root.app.foreground
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.body
  }

  Rectangle {
    width: parent.width
    height: Style.space(90)
    radius: Style.cornerRadius
    color: Util.alpha(root.app.foreground, 0.04)
    border.width: 1
    border.color: sample.activeFocus ? root.app.accent : root.app.line

    ScrollView {
      anchors.fill: parent
      anchors.margins: Style.space(2)

      TextArea {
        id: sample
        placeholderText: root.s.t("settings.parser.samplePlaceholder")
        placeholderTextColor: root.app.dim
        textFormat: TextEdit.PlainText
        // Payloads rarely need tab characters; Tab moves on to the Test button.
        Keys.onTabPressed: nextItemInFocusChain(true).forceActiveFocus(Qt.TabFocusReason)
        Keys.onBacktabPressed: nextItemInFocusChain(false).forceActiveFocus(Qt.BacktabFocusReason)
        wrapMode: TextEdit.Wrap
        selectByMouse: true
        color: root.app.foreground
        selectionColor: Util.alpha(root.app.accent, 0.35)
        font.family: "monospace"
        font.pixelSize: Style.font.body
        background: null
      }
    }
  }

  Button {

    focusable: true
    text: root.testing ? root.s.t("settings.parser.testing") : root.s.t("settings.parser.test")
    foreground: root.app.foreground
    accent: root.app.accent
    fontFamily: root.app.fontFamily
    bordered: true
    enabled: !root.testing
    onClicked: root.test()
  }

  // ---- result preview ----
  Rectangle {
    visible: root.result !== null
    width: parent.width
    implicitHeight: visible ? preview.implicitHeight + Style.space(12) * 2 : 0
    radius: Style.cornerRadius
    color: Util.alpha(root.result && root.result.fallback ? root.app.urgent : root.app.foreground, 0.08)
    border.width: 1
    border.color: root.app.line

    Column {
      id: preview
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(12)
      spacing: Style.space(6)

      PlainText {
        width: parent.width
        text: root.result && root.result.fallback ? root.s.t("settings.parser.fallback") : root.s.t("settings.parser.preview")
        color: root.result && root.result.fallback ? root.app.urgent : root.app.dim
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
      }

      Row {
        width: parent.width
        spacing: Style.space(10)

        PlainText {
          id: glyph
          text: Format.iconGlyph(root.result ? root.result.icon : "")
          color: root.app.foreground
          font.family: root.app.fontFamily
          font.pixelSize: Style.font.icon
        }

        PlainText {
          width: parent.width - glyph.width - parent.spacing
          text: root.result ? root.result.text : ""
          color: root.app.foreground
          font.family: root.app.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: Text.Wrap
        }
      }

      PlainText {
        width: parent.width
        text: root.s.t("settings.parser.iconLine").arg(root.result && root.result.icon ? root.result.icon : "null")
          + "    " + root.s.t("settings.parser.linkLine").arg(root.result && root.result.link ? root.result.link : "null")
        color: root.app.dim
        font.family: "monospace"
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
      }

      PlainText {
        visible: !!(root.result && root.result.error)
        width: parent.width
        text: root.result && root.result.error ? root.s.t("settings.parser.errorLine").arg(root.result.error) : ""
        color: root.app.urgent
        font.family: "monospace"
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
      }

      PlainText {
        visible: !!(root.result && root.result.warnings && root.result.warnings.length > 0)
        width: parent.width
        text: root.result && root.result.warnings ? root.result.warnings.join("\n") : ""
        color: root.app.accent
        font.family: "monospace"
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
      }

      PlainText {
        visible: !!(root.result && root.result.logs && root.result.logs.length > 0)
        width: parent.width
        text: root.result && root.result.logs ? root.result.logs.join("\n") : ""
        color: root.app.dim
        font.family: "monospace"
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
      }
    }
  }
}
