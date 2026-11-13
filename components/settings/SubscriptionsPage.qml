import QtQuick
import qs.Commons
import qs.Ui
import ".."

// Subscriptions grouped by broker; add / edit / delete / enable.
SettingsPage {
  id: page

  readonly property var s: app.strings
  readonly property var list: app.cfg ? app.cfg.brokers : []
  // {broker: index, sub: index or -1 for new} while editing
  property var editing: null
  property var deleting: null

  title: editing === null ? s.t("settings.subs.title") : (editing.sub === -1 ? s.t("settings.subs.add") : s.t("settings.subs.edit"))
  subtitle: editing === null ? s.t("settings.subs.subtitle") : list[editing.broker].name

  onEditingChanged: app.editing = editing !== null
  Component.onDestruction: app.editing = false
  Component.onCompleted: {
    var parts = app.takeEdit().split("/")
    for (var b = 0; b < list.length; b++) {
      if (list[b].id !== parts[0]) continue
      if (parts[1] === "new") editing = { broker: b, sub: -1 }
      for (var i = 0; i < list[b].subscriptions.length; i++) {
        if (list[b].subscriptions[i].id === parts[1]) editing = { broker: b, sub: i }
      }
    }
  }

  function save(mutate) {
    var brokers = app.brokers()
    mutate(brokers)
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
    visible: page.editing === null && page.list.length === 0
    width: parent.width
    topPadding: Style.space(24)
    horizontalAlignment: Text.AlignHCenter
    text: page.s.t("settings.subs.noBrokers")
    color: page.app.dim
    font.family: page.app.fontFamily
    font.pixelSize: Style.font.body
    wrapMode: Text.Wrap
  }

  Repeater {
    model: page.editing === null ? page.list : []
    delegate: Column {
      id: group
      required property var modelData
      required property int index
      readonly property var status: page.app.brokerStatus(modelData.id)
      width: parent.width
      spacing: Style.space(6)

      Item {
        width: parent.width
        implicitHeight: Math.max(groupTitle.implicitHeight, addButton.implicitHeight)

        StatusDot {
          id: dot
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          tone: page.app.statusColor(group.modelData.enabled ? (group.status ? group.status.state : "connecting") : "disabled")
        }

        PlainText {
          id: groupTitle
          anchors.left: dot.right
          anchors.leftMargin: Style.space(8)
          anchors.right: addButton.left
          anchors.verticalCenter: parent.verticalCenter
          text: group.modelData.name + "  ·  " + group.modelData.host
          color: page.app.foreground
          font.family: page.app.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Button {

          focusable: true
          id: addButton
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: page.s.t("settings.subs.add")
          foreground: page.app.foreground
          accent: page.app.accent
          fontFamily: page.app.fontFamily
          onClicked: page.editing = { broker: group.index, sub: -1 }
        }
      }

      PlainText {
        visible: group.modelData.subscriptions.length === 0
        width: parent.width
        leftPadding: Style.space(18)
        text: page.s.t("settings.subs.none")
        color: page.app.dim
        font.family: page.app.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Repeater {
        model: group.modelData.subscriptions
        delegate: Rectangle {
          id: subCard
          required property var modelData
          required property int index
          width: group.width
          implicitHeight: subRow.implicitHeight + Style.space(10) * 2
          radius: Style.cornerRadius
          color: page.app.subtle
          border.width: 1
          border.color: page.app.line

          Row {
            id: subRow
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(14)
            anchors.rightMargin: Style.space(10)
            spacing: Style.space(12)

            Column {
              width: parent.width - subToggle.width - subButtons.width - parent.spacing * 2
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              PlainText {
                width: parent.width
                text: subCard.modelData.topic
                color: page.app.foreground
                font.family: page.app.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
                elide: Text.ElideMiddle
              }

              PlainText {
                width: parent.width
                text: "QoS " + subCard.modelData.qos
                  + " · " + (subCard.modelData.parserFile ? page.s.t("settings.subs.parserFile").arg(subCard.modelData.parserFile)
                    : (subCard.modelData.parserScript.trim() !== "" ? page.s.t("settings.subs.parserCustom") : page.s.t("settings.subs.parserDefault")))
                  + (subCard.modelData.description ? " · " + subCard.modelData.description : "")
                color: page.app.dim
                font.family: page.app.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }

            ToggleSwitch {
              id: subToggle
              anchors.verticalCenter: parent.verticalCenter
              checked: subCard.modelData.enabled
              foreground: page.app.foreground
              accent: page.app.accent
              onToggled: {
                var b = group.index
                var i = subCard.index
                page.save(function(brokers) { brokers[b].subscriptions[i].enabled = !brokers[b].subscriptions[i].enabled })
              }
            }

            Row {
              id: subButtons
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              Button {

                focusable: true
                text: page.s.t("settings.edit")
                foreground: page.app.foreground
                accent: page.app.accent
                fontFamily: page.app.fontFamily
                onClicked: page.editing = { broker: group.index, sub: subCard.index }
              }

              Button {

                focusable: true
                text: page.s.t("settings.delete")
                foreground: page.app.urgent
                accent: page.app.urgent
                fontFamily: page.app.fontFamily
                onClicked: page.deleting = { broker: group.index, sub: subCard.index, topic: subCard.modelData.topic }
              }
            }
          }
        }
      }
    }
  }

  Loader {
    width: parent.width
    active: page.editing !== null
    sourceComponent: SubscriptionEditor {
      width: parent ? parent.width : 0
      app: page.app
      brokerIndex: page.editing ? page.editing.broker : 0
      subIndex: page.editing ? page.editing.sub : -1
      onFinished: page.editing = null
    }
  }

  ConfirmDialog {
    parent: page
    anchors.fill: parent
    z: 10
    opened: page.deleting !== null
    message: page.deleting ? page.s.t("settings.subs.confirmDelete").arg(page.deleting.topic) : ""
    confirmText: page.s.t("settings.delete")
    background: page.app.background
    foreground: page.app.foreground
    fontFamily: page.app.fontFamily
    focus: opened
    Keys.onPressed: function(event) { if (handleKey(event)) event.accepted = true }
    onCanceled: page.deleting = null
    onConfirmed: {
      var d = page.deleting
      page.deleting = null
      page.save(function(brokers) { brokers[d.broker].subscriptions.splice(d.sub, 1) })
    }
  }
}
