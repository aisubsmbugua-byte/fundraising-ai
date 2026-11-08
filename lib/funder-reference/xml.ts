// Item 110 (ruling 0045): a small, strict XML reader for IRS e-file returns.
//
// WHY NOT A LIBRARY. The project has no XML dependency and the IRS returns are
// machine-written, namespace-light documents. A reader this size is easier to
// audit than a dependency, and strictness is the point: a document that is not
// well formed must be REJECTED (and recorded as unread, ruling 0045 clause 6),
// never half-read.
//
// WHAT IT ACCEPTS: a prolog, comments, processing instructions, CDATA, elements
// with attributes, character data, the five predefined entities and numeric
// character references. WHAT IT REFUSES: a DOCTYPE (no entity expansion, so no
// entity-bomb surface), mismatched or unclosed tags, text outside the root,
// more than one root, an unknown named entity.

export interface XmlNode {
  name: string; // local name; any namespace prefix is dropped
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string; // direct character data, trimmed; "" when there is none
}

export class XmlError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = "XmlError";
  }
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string, at: number): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (_m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) throw new XmlError(`bad character reference &${body};`, at);
      return String.fromCodePoint(code);
    }
    const v = NAMED[body];
    if (v === undefined) throw new XmlError(`unknown entity &${body};`, at);
    return v;
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i < 0 ? qname : qname.slice(i + 1);
}

const NAME_CHARS = /[^\s/>=]+/y;

export function parseXml(src: string): XmlNode {
  let i = 0;
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) i = 1; // byte-order mark
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const textParts: string[][] = [];

  while (i < n) {
    const lt = src.indexOf("<", i);
    const chunkEnd = lt < 0 ? n : lt;
    if (chunkEnd > i) {
      const raw = src.slice(i, chunkEnd);
      if (stack.length === 0) {
        if (raw.trim() !== "") throw new XmlError("text outside the root element", i);
      } else {
        textParts[textParts.length - 1].push(decodeEntities(raw, i));
      }
    }
    if (lt < 0) break;
    i = lt;

    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 4);
      if (e < 0) throw new XmlError("unterminated comment", i);
      i = e + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      if (stack.length === 0) throw new XmlError("CDATA outside the root element", i);
      const e = src.indexOf("]]>", i + 9);
      if (e < 0) throw new XmlError("unterminated CDATA", i);
      textParts[textParts.length - 1].push(src.slice(i + 9, e));
      i = e + 3;
    } else if (src.startsWith("<?", i)) {
      const e = src.indexOf("?>", i + 2);
      if (e < 0) throw new XmlError("unterminated processing instruction", i);
      i = e + 2;
    } else if (src.startsWith("<!", i)) {
      throw new XmlError("DOCTYPE and other declarations are not accepted", i);
    } else if (src.startsWith("</", i)) {
      const e = src.indexOf(">", i + 2);
      if (e < 0) throw new XmlError("unterminated end tag", i);
      const name = localName(src.slice(i + 2, e).trim());
      const open = stack.pop();
      if (!open) throw new XmlError(`end tag </${name}> with nothing open`, i);
      if (open.name !== name) throw new XmlError(`end tag </${name}> closes <${open.name}>`, i);
      open.text = textParts.pop()!.join("").trim();
      i = e + 1;
    } else {
      // start tag
      let j = i + 1;
      NAME_CHARS.lastIndex = j;
      const m = NAME_CHARS.exec(src);
      if (!m) throw new XmlError("start tag with no name", i);
      const name = localName(m[0]);
      j += m[0].length;
      const attrs: Record<string, string> = {};
      let selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++;
        if (j >= n) throw new XmlError("unterminated start tag", i);
        if (src[j] === ">") {
          j++;
          break;
        }
        if (src[j] === "/" && src[j + 1] === ">") {
          selfClose = true;
          j += 2;
          break;
        }
        NAME_CHARS.lastIndex = j;
        const a = NAME_CHARS.exec(src);
        if (!a) throw new XmlError("bad attribute", j);
        j += a[0].length;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] !== "=") throw new XmlError(`attribute ${a[0]} has no value`, j);
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q !== '"' && q !== "'") throw new XmlError(`attribute ${a[0]} value is not quoted`, j);
        const qe = src.indexOf(q, j + 1);
        if (qe < 0) throw new XmlError("unterminated attribute value", j);
        const aname = localName(a[0]);
        // namespace declarations are not data
        if (!/^xmlns(:|$)/.test(a[0])) attrs[aname] = decodeEntities(src.slice(j + 1, qe), j);
        j = qe + 1;
      }
      const node: XmlNode = { name, attrs, children: [], text: "" };
      if (stack.length === 0) {
        if (root) throw new XmlError("more than one root element", i);
        root = node;
      } else {
        stack[stack.length - 1].children.push(node);
      }
      if (!selfClose) {
        stack.push(node);
        textParts.push([]);
      }
      i = j;
    }
  }
  if (stack.length > 0) throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`, n);
  if (!root) throw new XmlError("no root element", 0);
  return root;
}

// --- navigation helpers -----------------------------------------------------

export function child(node: XmlNode | null | undefined, name: string): XmlNode | null {
  if (!node) return null;
  for (const c of node.children) if (c.name === name) return c;
  return null;
}

export function childrenNamed(node: XmlNode | null | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** First node along a "A/B/C" path of child names, or null. */
export function at(node: XmlNode | null | undefined, path: string): XmlNode | null {
  let cur: XmlNode | null | undefined = node;
  for (const part of path.split("/")) {
    cur = child(cur, part);
    if (!cur) return null;
  }
  return cur ?? null;
}

/** Text at a path, or null when the element is absent or empty. Absent is not "". */
export function textAt(node: XmlNode | null | undefined, path: string): string | null {
  const t = at(node, path);
  if (!t) return null;
  return t.text === "" ? null : t.text;
}

/** Every descendant (document order) with this name. */
export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/**
 * Every leaf element under `node`, as [path, text] in document order, where the
 * path is the names from (but not including) `node` joined by "/". Repeated
 * siblings are not indexed; callers that need indices walk the tree themselves.
 */
export function leaves(node: XmlNode, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (nd: XmlNode, p: string) => {
    for (const c of nd.children) {
      const cp = p ? `${p}/${c.name}` : c.name;
      if (c.children.length === 0) out.push([cp, c.text]);
      else walk(c, cp);
    }
  };
  walk(node, prefix);
  return out;
}
