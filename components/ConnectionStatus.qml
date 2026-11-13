import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../lib/format.mjs" as Format

// Red warning block: one line per unreachable broker, plus helper and config
// errors. Hidden when everything is fine.
Item {
  id: root

  property var warnings: []        // broker status objects from the helper
  property string helperError: ""
  property string configError: ""
  property var configProblems: []
  property var strings: null       // Commons.Translations of the plugin
  property color foreground: Commons.Color.foreground
  property color urgent: Commons.Color.urgent
  property string fontFamily: Style.font.family

  signal retryRequested()

  readonly property var lines: {
    var out = []
    if (helperError !== "") out.push(helperError)
    for (var i = 0; i < warnings.length; i++) {
      var b = warnings[i]
      var line = strings ? strings.t("status.unreachable").arg(b.name) : "Broker " + b.name + " is unreachable"
      if (b.error) line += " — " + b.error
      out.push(line)
    }
    if (configError !== "") out.push(configError)
    for (var j = 0; j < configProblems.length; j++) out.push(String(configProblems[j]))
    return out
  }

  visible: lines.length > 0
  implicitHeight: visible ? box.implicitHeight : 0

  Rectangle {
    id: box
    width: parent.width
    implicitHeight: column.implicitHeight + Style.space(10) * 2
    radius: Style.cornerRadius
    color: Util.alpha(root.urgent, 0.14)
    border.width: Math.max(1, Style.space(1))
    border.color: Util.alpha(root.urgent, 0.55)

    Column {
      id: column
      anchors.left: parent.left
      anchors.right: actions.left
      anchors.top: parent.top
      anchors.margins: Style.space(10)
      spacing: Style.space(4)

      Repeater {
        model: root.lines
        delegate: Row {
          required property string modelData
          width: column.width
          spacing: Style.space(8)

          PlainText {
            id: warnGlyph
            text: Format.ICON_WARNING
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          PlainText {
            width: parent.width - warnGlyph.implicitWidth - parent.spacing
            text: modelData
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
          }
        }
      }
    }

    Row {
      id: actions
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(6)
      spacing: Style.space(2)

      PanelActionButton {
        visible: root.warnings.length > 0
        iconText: Format.ICON_RETRY
        tooltipText: root.strings ? root.strings.t("status.retry") : "Reconnect now"
        foreground: root.urgent
        fontFamily: root.fontFamily
        onClicked: root.retryRequested()
      }
    }
  }
}
