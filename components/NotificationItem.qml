import QtQuick
import qs.Commons
import qs.Commons as Commons
import "../lib/format.mjs" as Format

// One notification row. All MQTT-derived strings use PlainText.
Item {
  id: root

  required property int index
  required property int seq
  required property string nid
  required property string timestamp
  required property string brokerName
  required property string topic
  required property string body
  required property string icon
  required property string link
  required property bool read

  property color foreground: Commons.Color.foreground
  property color accent: Commons.Color.accent
  property color urgent: Commons.Color.urgent
  property string fontFamily: Style.font.family
  property bool selected: false
  property string openLinkLabel: ""

  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property bool hovered: hover.hovered
  readonly property string host: Format.linkHost(link)

  signal linkActivated(string url)

  implicitHeight: content.implicitHeight + Style.space(8) * 2

  function toneColor(tone) {
    if (tone === "urgent") return urgent
    if (tone === "accent") return accent
    if (tone === "dim") return dim
    return foreground
  }

  function displayTime(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ""
    var locale = Qt.locale(Commons.I18n.formatLocale)
    var time = d.toLocaleTimeString(locale, Locale.ShortFormat)
    return Format.sameDay(d, new Date()) ? time : d.toLocaleDateString(locale, Locale.ShortFormat) + " " + time
  }

  HoverHandler { id: hover }

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.selected ? Style.selectedFillFor(root.foreground, root.accent)
      : root.hovered ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"
  }

  Item {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.leftMargin: Style.space(8)
    anchors.rightMargin: Style.space(8)
    anchors.topMargin: Style.space(8)
    implicitHeight: Math.max(glyph.implicitHeight, column.implicitHeight)

    PlainText {
      id: glyph
      anchors.left: parent.left
      anchors.top: parent.top
      width: Style.space(20)
      text: Format.iconGlyph(root.icon)
      color: root.toneColor(Format.iconTone(root.icon))
      font.family: root.fontFamily
      font.pixelSize: Style.font.icon
      horizontalAlignment: Text.AlignHCenter
    }

    Column {
      id: column
      anchors.left: glyph.right
      anchors.leftMargin: Style.space(10)
      anchors.right: unreadDot.left
      anchors.rightMargin: Style.space(6)
      anchors.top: parent.top
      spacing: Style.space(3)

      Row {
        width: parent.width
        spacing: Style.space(6)

        PlainText {
          id: timeText
          text: root.displayTime(root.timestamp)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PlainText {
          width: Math.max(0, parent.width - timeText.implicitWidth - parent.spacing)
          text: root.brokerName + " · " + root.topic
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
      }

      PlainText {
        width: parent.width
        text: root.body
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: !root.read
        wrapMode: Text.Wrap
        maximumLineCount: 8
        elide: Text.ElideRight
      }

      Item {
        visible: root.host !== ""
        width: parent.width
        implicitHeight: linkRow.implicitHeight

        Row {
          id: linkRow
          spacing: Style.space(4)

          PlainText {
            text: Format.ICON_LINK
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          PlainText {
            text: root.openLinkLabel !== "" ? root.openLinkLabel.arg(root.host) : root.host
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.underline: linkMouse.containsMouse
          }
        }

        MouseArea {
          id: linkMouse
          anchors.fill: linkRow
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.linkActivated(root.link)
        }
      }
    }

    Rectangle {
      id: unreadDot
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.topMargin: Style.space(4)
      width: Style.space(6)
      height: width
      radius: width / 2
      color: root.accent
      opacity: root.read ? 0 : 1
    }
  }
}
