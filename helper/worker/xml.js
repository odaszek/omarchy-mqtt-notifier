// Minimal, dependency-free XML → plain object parser for parser scripts.
//
// parseXml('<sensor id="a"><t>29.5</t><t>30</t></sensor>')
//   → { sensor: { "@_id": "a", t: ["29.5", "30"] } }
//
// Conventions: attributes are "@_name"; an element with only text becomes a
// string; repeated children become arrays; text mixed with child elements is
// kept as "#text". Values are never type-converted.
//
// Safety: DOCTYPE declarations are skipped and never expanded (no external or
// custom entities), and depth and node counts are bounded.

const MAX_DEPTH = 64
const MAX_NODES = 10000
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole
  })
}

function nameAt(xml, at) {
  NAME.lastIndex = at
  const m = NAME.exec(xml)
  return m ? m[0] : null
}

function addChild(target, name, value) {
  if (!Object.prototype.hasOwnProperty.call(target, name)) {
    target[name] = value
  } else if (Array.isArray(target[name])) {
    target[name].push(value)
  } else {
    target[name] = [target[name], value]
  }
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y
const ATTR = /\s*([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/y

export function parseXml(input) {
  const xml = String(input ?? "")
  let i = 0
  let nodes = 0
  const root = {}
  // Stack frames: { name, obj, text, hasChildren }
  const stack = [{ name: "", obj: root, text: "", hasChildren: false }]

  function fail(message) {
    throw new SyntaxError("parseXml: " + message + " at offset " + i)
  }

  function finish(frame) {
    const text = frame.text.trim()
    const keys = Object.keys(frame.obj)
    if (keys.length === 0) return text
    if (text !== "") frame.obj["#text"] = text
    return frame.obj
  }

  while (i < xml.length) {
    const lt = xml.indexOf("<", i)
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(xml.slice(i, lt))
    i = lt

    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4)
      if (end === -1) fail("unterminated comment")
      i = end + 3
    } else if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9)
      if (end === -1) fail("unterminated CDATA")
      stack[stack.length - 1].text += xml.slice(i + 9, end)
      i = end + 3
    } else if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2)
      if (end === -1) fail("unterminated processing instruction")
      i = end + 2
    } else if (xml.startsWith("<!", i)) {
      // DOCTYPE or other declaration: skip, including an internal subset.
      let depth = 0
      let j = i + 2
      for (; j < xml.length; j++) {
        const c = xml[j]
        if (c === "[") depth++
        else if (c === "]") depth--
        else if (c === ">" && depth <= 0) break
      }
      if (j >= xml.length) fail("unterminated declaration")
      i = j + 1
    } else if (xml[i + 1] === "/") {
      const name = nameAt(xml, i + 2)
      if (!name) fail("invalid closing tag")
      const end = xml.indexOf(">", i + 2 + name.length)
      if (end === -1) fail("unterminated closing tag")
      const frame = stack.pop()
      if (!frame || frame.name !== name) fail("mismatched closing tag </" + name + ">")
      addChild(stack[stack.length - 1].obj, name, finish(frame))
      stack[stack.length - 1].hasChildren = true
      i = end + 1
    } else {
      const name = nameAt(xml, i + 1)
      if (!name) fail("invalid tag")
      if (++nodes > MAX_NODES) fail("too many elements")
      if (stack.length > MAX_DEPTH) fail("nesting too deep")
      const obj = {}
      let j = i + 1 + name.length
      for (;;) {
        ATTR.lastIndex = j
        const a = ATTR.exec(xml)
        if (!a) break
        obj["@_" + a[1]] = decodeEntities(a[3] !== undefined ? a[3] : a[4])
        j = ATTR.lastIndex
      }
      while (j < xml.length && /\s/.test(xml[j])) j++
      if (xml.startsWith("/>", j)) {
        addChild(stack[stack.length - 1].obj, name, Object.keys(obj).length ? obj : "")
        stack[stack.length - 1].hasChildren = true
        i = j + 2
      } else if (xml[j] === ">") {
        stack.push({ name, obj, text: "", hasChildren: false })
        i = j + 1
      } else {
        fail("malformed tag <" + name + ">")
      }
    }
  }

  if (stack.length !== 1) fail("unclosed tag <" + stack[stack.length - 1].name + ">")
  if (Object.keys(root).length === 0) fail("no root element")
  return root
}
