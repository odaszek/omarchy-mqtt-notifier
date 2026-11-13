import QtQuick
import qs.Commons
import ".."

// Inline result/error message under a form.
Rectangle {
  id: root

  required property var app
  property string text: ""
  property bool error: false

  visible: text !== ""
  width: parent ? parent.width : 0
  implicitHeight: visible ? body.implicitHeight + Style.space(10) * 2 : 0
  radius: Style.cornerRadius
  color: Util.alpha(error ? app.urgent : app.foreground, error ? 0.14 : 0.06)
  border.width: 1
  border.color: Util.alpha(error ? app.urgent : app.foreground, 0.3)

  PlainText {
    id: body
    anchors.fill: parent
    anchors.margins: Style.space(10)
    text: root.text
    color: root.error ? root.app.urgent : root.app.foreground
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.bodySmall
    wrapMode: Text.Wrap
  }
}
