import QtQuick
import qs.Commons
import ".."

// Label on the left, one control on the right, optional hint or error below.
Item {
  id: root

  required property var app
  property string label: ""
  property string hint: ""
  property string error: ""
  property real labelWidth: Style.space(170)
  default property alias control: slot.data

  width: parent ? parent.width : 0
  implicitHeight: Math.max(labelText.implicitHeight, slot.childrenRect.height) + (below.visible ? below.implicitHeight + Style.space(4) : 0)

  PlainText {
    id: labelText
    width: root.labelWidth
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.topMargin: Style.space(6)
    text: root.label
    color: root.app.foreground
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.body
    wrapMode: Text.Wrap
  }

  Item {
    id: slot
    anchors.left: labelText.right
    anchors.leftMargin: Style.space(12)
    anchors.right: parent.right
    anchors.top: parent.top
    height: childrenRect.height
  }

  PlainText {
    id: below
    anchors.left: slot.left
    anchors.right: parent.right
    anchors.top: slot.bottom
    anchors.topMargin: Style.space(4)
    visible: text !== ""
    text: root.error !== "" ? root.error : root.hint
    color: root.error !== "" ? root.app.urgent : root.app.dim
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }
}
