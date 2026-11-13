import QtQuick
import QtQuick.Controls
import QtQuick.Window
import qs.Commons
import ".."

// Scrollable page with a title, an optional subtitle and a header action area.
Item {
  id: root

  required property var app
  property string title: ""
  property string subtitle: ""
  default property alias content: column.data
  property alias headerActions: actions.data
  property alias flick: flick

  // Keyboard navigation: scroll the focused control into view.
  function ensureVisible(item) {
    if (!item) return
    var p = item
    while (p && p !== column) p = p.parent
    if (!p) return
    var y = item.mapToItem(column, 0, 0).y
    var pad = Style.space(16)
    if (y < flick.contentY + pad) flick.contentY = Math.max(0, y - pad)
    else if (y + item.height > flick.contentY + flick.height - pad)
      flick.contentY = Math.min(Math.max(0, flick.contentHeight - flick.height), y + item.height - flick.height + pad)
  }

  Connections {
    target: root.Window.window
    function onActiveFocusItemChanged() { root.ensureVisible(root.Window.window.activeFocusItem) }
  }

  Item {
    id: header
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    implicitHeight: Math.max(titleColumn.implicitHeight, actions.implicitHeight)

    Column {
      id: titleColumn
      anchors.left: parent.left
      anchors.right: actions.left
      anchors.rightMargin: Style.space(12)
      spacing: Style.space(4)

      PlainText {
        width: parent.width
        text: root.title
        color: root.app.foreground
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
      }

      PlainText {
        width: parent.width
        visible: root.subtitle !== ""
        text: root.subtitle
        color: root.app.dim
        font.family: root.app.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.Wrap
      }
    }

    Row {
      id: actions
      anchors.right: parent.right
      anchors.top: parent.top
      spacing: Style.space(8)
    }
  }

  Flickable {
    id: flick
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: header.bottom
    anchors.topMargin: Style.space(16)
    anchors.bottom: parent.bottom
    contentWidth: width
    contentHeight: column.implicitHeight + Style.space(16)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: column
      width: flick.width - Style.space(12)
      spacing: Style.space(12)
    }
  }
}
