import QtQuick
import qs.Commons
import qs.Ui
import ".."

// Broker list with live connection state; add / edit / delete / enable.
SettingsPage {
  id: page

  readonly property var s: app.strings
  // Index being edited: -1 = list, -2 = new broker.
  property int editIndex: -1
  property int deleteIndex: -1
  readonly property var list: app.cfg ? app.cfg.brokers : []

  title: editIndex === -1 ? s.t("settings.brokers.title") : (editIndex === -2 ? s.t("settings.brokers.add") : s.t("settings.brokers.edit"))
  subtitle: editIndex === -1 ? s.t("settings.brokers.subtitle") : ""

  onEditIndexChanged: app.editing = editIndex !== -1
  Component.onDestruction: app.editing = false
  Component.onCompleted: {
    var edit = app.takeEdit()
    if (edit === "new") editIndex = -2
    else for (var i = 0; i < list.length; i++) if (list[i].id === edit) editIndex = i
  }

  headerActions: [
    Button {
      focusable: true
      visible: page.editIndex === -1
      text: page.s.t("settings.brokers.add")
      foreground: page.app.foreground
      accent: page.app.accent
      fontFamily: page.app.fontFamily
      bordered: true
      onClicked: page.editIndex = -2
    }
  ]

  function toggleEnabled(index) {
    var brokers = app.brokers()
    brokers[index].enabled = !brokers[index].enabled
    app.saveBrokers(brokers, {}, function(ok, errors) {
      result.error = !ok
      result.text = ok ? "" : app.errorLines(errors)
    })
  }

  function remove(index) {
    var brokers = app.brokers()
    brokers.splice(index, 1)
    app.saveBrokers(brokers, {}, function(ok, errors) {
      result.error = !ok
      result.text = ok ? "" : app.errorLines(errors)
    })
  }

  MessageBox {
    id: result
    app: page.app
  }

  PlainText {
    visible: page.editIndex === -1 && page.list.length === 0
    width: parent.width
    topPadding: Style.space(24)
    horizontalAlignment: Text.AlignHCenter
    text: page.s.t("settings.brokers.empty")
    color: page.app.dim
    font.family: page.app.fontFamily
    font.pixelSize: Style.font.body
    wrapMode: Text.Wrap
  }

  Repeater {
    model: page.editIndex === -1 ? page.list : []
    delegate: Rectangle {
      id: card
      required property var modelData
      required property int index
      readonly property var status: page.app.brokerStatus(modelData.id)

      width: parent.width
      implicitHeight: row.implicitHeight + Style.space(12) * 2
      radius: Style.cornerRadius
      color: page.app.subtle
      border.width: 1
      border.color: page.app.line

      Row {
        id: row
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(14)
        anchors.rightMargin: Style.space(10)
        spacing: Style.space(12)

        StatusDot {
          anchors.verticalCenter: parent.verticalCenter
          tone: page.app.statusColor(card.modelData.enabled ? (card.status ? card.status.state : "connecting") : "disabled")
        }

        Column {
          width: parent.width - Style.space(10) - toggle.width - buttons.width - parent.spacing * 3
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          PlainText {
            width: parent.width
            text: card.modelData.name
            color: page.app.foreground
            font.family: page.app.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
            elide: Text.ElideRight
          }

          PlainText {
            width: parent.width
            text: (card.modelData.protocol === "mqtts" ? "mqtts://" : "mqtt://") + card.modelData.host + ":" + card.modelData.port
              + " · MQTT " + (card.modelData.mqttVersion === 5 ? "5.0" : "3.1.1")
              + " · " + page.s.tn("settings.brokers.subCount", card.modelData.subscriptions.length).arg(card.modelData.subscriptions.length)
            color: page.app.dim
            font.family: page.app.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          PlainText {
            width: parent.width
            text: page.app.statusLabel(card.status, card.modelData.enabled)
              + (card.status && card.status.error && card.modelData.enabled ? " — " + card.status.error : "")
            color: page.app.statusColor(card.modelData.enabled ? (card.status ? card.status.state : "connecting") : "disabled")
            font.family: page.app.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        ToggleSwitch {
          id: toggle
          anchors.verticalCenter: parent.verticalCenter
          checked: card.modelData.enabled
          foreground: page.app.foreground
          accent: page.app.accent
          onToggled: page.toggleEnabled(card.index)
        }

        Row {
          id: buttons
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          Button {

            focusable: true
            text: page.s.t("settings.edit")
            foreground: page.app.foreground
            accent: page.app.accent
            fontFamily: page.app.fontFamily
            onClicked: page.editIndex = card.index
          }

          Button {

            focusable: true
            text: page.s.t("settings.delete")
            foreground: page.app.urgent
            accent: page.app.urgent
            fontFamily: page.app.fontFamily
            onClicked: page.deleteIndex = card.index
          }
        }
      }
    }
  }

  Loader {
    width: parent.width
    active: page.editIndex !== -1
    sourceComponent: BrokerEditor {
      width: parent ? parent.width : 0
      app: page.app
      index: page.editIndex
      onFinished: page.editIndex = -1
    }
  }

  ConfirmDialog {
    parent: page
    anchors.fill: parent
    z: 10
    opened: page.deleteIndex !== -1
    message: page.deleteIndex >= 0 && page.deleteIndex < page.list.length
      ? page.s.t("settings.brokers.confirmDelete").arg(page.list[page.deleteIndex].name) : ""
    confirmText: page.s.t("settings.delete")
    background: page.app.background
    foreground: page.app.foreground
    fontFamily: page.app.fontFamily
    focus: opened
    Keys.onPressed: function(event) { if (handleKey(event)) event.accepted = true }
    onCanceled: page.deleteIndex = -1
    onConfirmed: {
      var index = page.deleteIndex
      page.deleteIndex = -1
      page.remove(index)
    }
  }
}
