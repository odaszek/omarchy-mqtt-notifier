import QtQuick

// Every text element in this plugin goes through here. MQTT payloads, topics
// and broker names are untrusted: Text.AutoText would render markup such as
// <img src="https://…"> as rich text and load remote resources.
Text {
  textFormat: Text.PlainText
}
