import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "components"
import "lib/format.mjs" as Format

// Bar icon + notification panel. One instance per bar/screen; all state lives
// in Service.qml, so closing the panel (or losing a monitor) never touches the
// MQTT connections.
Panel {
  id: root
  moduleName: "odach.mqtt-notifier"
  // Opening from outside: `omarchy-shell shell summon odach.mqtt-notifier`
  // picks the instance on the focused screen. (Third-party plugins cannot
  // register their own IPC targets, so there is no per-widget handler.)
  manageIpc: false

  property var service: null
  readonly property bool ready: service !== null
  readonly property int unread: ready ? service.unread : 0
  readonly property var warnings: ready ? service.brokerWarnings : []
  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color accent: Commons.Color.accent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  property int cursorIndex: -1
  property bool clearConfirmOpen: false

  Commons.Translations {
    id: strings
    directory: Qt.resolvedUrl("i18n")
  }

  // The service registers asynchronously; look it up until it exists.
  Timer {
    interval: 250
    repeat: true
    running: root.service === null
    triggeredOnStart: true
    onTriggered: {
      var api = root.bar ? root.bar.shell : null
      if (api && typeof api.serviceFor === "function") root.service = api.serviceFor(root.moduleName)
    }
  }

  // A widget torn down while open (bar reload, monitor unplugged) still counts as closing.
  Component.onDestruction: if (opened && service) service.panelClosed()

  // Desktop notification clicked: only the widget on the focused screen opens.
  Connections {
    target: root.service
    function onPanelRequested() {
      var monitor = Hyprland.focusedMonitor
      var window = root.QsWindow.window
      var mine = window && window.screen ? String(window.screen.name || "") : ""
      if (!monitor || mine === "" || mine === String(monitor.name || "")) root.open()
    }
  }

  onOpenedChanged: {
    if (!service) return
    if (opened) {
      cursorIndex = -1
      clearConfirmOpen = false
      service.panelOpened()
    } else {
      service.panelClosed()
    }
  }

  function openLink(url) {
    var safe = Format.safeLink(url)
    if (safe === "") return
    Qt.openUrlExternally(safe)
    close()
  }

  function moveCursor(delta) {
    if (!service || service.items.count === 0) return
    // Moving past the last row loads the next page, like clicking More.
    if (delta > 0 && cursorIndex >= service.items.count - 1 && service.hasMore) {
      service.loadMore()
      return
    }
    cursorIndex = Math.max(0, Math.min(service.items.count - 1, cursorIndex + delta))
    if (panel.loadedContent) panel.loadedContent.list.positionViewAtIndex(cursorIndex, ListView.Contain)
  }

  function activateCursor() {
    if (!service || cursorIndex < 0 || cursorIndex >= service.items.count) return
    var link = service.items.get(cursorIndex).link
    if (link) openLink(link)
  }

  function badgeText(count) {
    if (count <= 0) return ""
    return count > 99 ? "99+" : Commons.I18n.formatNumber(count)
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.warnings.length > 0 ? Format.BAR_ICON_ALERT : root.unread > 0 ? Format.BAR_ICON_UNREAD : Format.BAR_ICON
    active: root.warnings.length > 0
    labelText: root.ready && root.service.showUnreadCounter && !vertical ? root.badgeText(root.unread) : ""
    slotSize: Style.bar.iconSlot * (labelText !== "" ? 2 : 1)
    tooltipText: root.opened ? "" : (root.warnings.length > 0
      ? strings.tn("tooltip.brokersDown", root.warnings.length).arg(Commons.I18n.formatNumber(root.warnings.length))
      : strings.tn("tooltip.unread", root.unread).arg(Commons.I18n.formatNumber(root.unread)))
    onPressed: function(b) {
      if (b === Qt.LeftButton || b === Qt.RightButton) root.toggle()
      else if (b === Qt.MiddleButton && root.service) root.service.reconnect()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.ready
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(root.ready ? root.service.popupWidth : 380))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Style.space(root.ready ? root.service.popupMaxHeight : 600))

    content: PanelKeyCatcher {
      id: keyCatcher
      property alias list: list
      anchors.fill: parent
      blocked: root.clearConfirmOpen
      implicitHeight: fixedHeight + list.contentHeight

      // Everything except the list; the list gets what is left up to the panel's max height.
      readonly property int visibleBlocks: (status.visible ? 1 : 0) + (emptyText.visible ? 1 : 0)
        + (list.visible ? 1 : 0) + (moreRow.visible ? 1 : 0) + 2
      readonly property real fixedHeight: header.implicitHeight + status.implicitHeight
        + (emptyText.visible ? emptyText.implicitHeight : 0) + moreRow.implicitHeight + footer.implicitHeight
        + column.spacing * Math.max(0, visibleBlocks - 1)

      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onDeleteRequested: if (root.ready && root.service.total > 0) root.clearConfirmOpen = true

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(10)

        // ---- header ----
        Item {
          id: header
          width: parent.width
          implicitHeight: Math.max(title.implicitHeight, countText.implicitHeight)

          PlainText {
            id: title
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: strings.t("panel.title")
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          PlainText {
            id: countText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: root.ready && root.service.total > 0
            text: root.ready ? strings.tn("panel.unreadOfTotal", root.service.total)
              .arg(Commons.I18n.formatNumber(root.unread)).arg(Commons.I18n.formatNumber(root.service.total)) : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        // ---- A. connection status ----
        ConnectionStatus {
          id: status
          width: parent.width
          warnings: root.warnings
          helperError: root.ready ? root.service.helperError : ""
          configError: root.ready ? root.service.configError : ""
          configProblems: root.ready ? root.service.configProblems : []
          strings: strings
          foreground: root.foreground
          urgent: root.urgent
          fontFamily: root.fontFamily
          onRetryRequested: root.service.reconnect()
        }

        // ---- B. notification list ----
        PlainText {
          id: emptyText
          visible: !root.ready || root.service.items.count === 0
          width: parent.width
          topPadding: Style.space(16)
          bottomPadding: Style.space(16)
          horizontalAlignment: Text.AlignHCenter
          text: strings.t("panel.empty")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        ListView {
          id: list
          width: parent.width
          height: Math.max(0, Math.min(contentHeight, keyCatcher.height - keyCatcher.fixedHeight))
          visible: count > 0
          clip: true
          spacing: Style.space(2)
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          model: root.ready ? root.service.items : null
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          delegate: NotificationItem {
            width: ListView.view.width
            foreground: root.foreground
            accent: root.accent
            urgent: root.urgent
            fontFamily: root.fontFamily
            selected: root.cursorIndex === index
            openLinkLabel: strings.t("item.openLink")
            onLinkActivated: function(url) { root.openLink(url) }
          }
        }

        // ---- More ----
        Item {
          id: moreRow
          width: parent.width
          visible: root.ready && root.service.hasMore
          implicitHeight: visible ? moreText.implicitHeight + Style.space(4) : 0

          PlainText {
            id: moreText
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.service && root.service.loading ? strings.t("panel.loading") : strings.t("panel.more")
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.underline: moreMouse.containsMouse
          }

          MouseArea {
            id: moreMouse
            anchors.fill: moreText
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.service.loadMore()
          }
        }

        // ---- C. footer ----
        Item {
          id: footer
          width: parent.width
          implicitHeight: clearButton.implicitHeight

          PanelActionButton {
            id: clearButton
            anchors.left: parent.left
            iconText: Format.ICON_CLEAR
            tooltipText: strings.t("panel.clearAll")
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready && root.service.total > 0
            opacity: enabled ? 1 : 0.4
            onClicked: root.clearConfirmOpen = true
          }

          PlainText {
            anchors.centerIn: parent
            width: parent.width - clearButton.width - settingsButton.width - Style.space(16)
            horizontalAlignment: Text.AlignHCenter
            visible: root.ready && root.service.lastWarning !== "" && root.warnings.length === 0
            text: root.ready ? root.service.lastWarning : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          PanelActionButton {
            id: settingsButton
            anchors.right: parent.right
            iconText: Format.ICON_SETTINGS
            tooltipText: strings.t("panel.settings")
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: {
              root.close()
              root.service.openSettings("")
            }
          }
        }
      }

      ConfirmDialog {
        id: clearConfirm
        anchors.fill: parent
        z: 10
        opened: root.clearConfirmOpen
        // While open, the key catcher is blocked and forwards keys here.
        focus: opened
        onOpenedChanged: opened ? forceActiveFocus() : keyCatcher.forceActiveFocus()
        Keys.onPressed: function(event) { if (handleKey(event)) event.accepted = true }
        message: strings.t("confirm.clear")
        confirmText: strings.t("confirm.clearConfirm")
        background: Commons.Color.popups.background
        foreground: root.foreground
        fontFamily: root.fontFamily
        onCanceled: root.clearConfirmOpen = false
        onConfirmed: {
          root.clearConfirmOpen = false
          root.cursorIndex = -1
          root.service.clearAll()
        }
      }
    }
  }
}
