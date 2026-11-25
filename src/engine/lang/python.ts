import { collapse, field, named, type DeclShape, type Hooks, type ImportFact, type Node } from '../syntax.js';

function stringValue(n: Node): string | null {
  if (n.type !== 'string' || named(n).some((c) => c.type === 'interpolation')) return null;
  return named(n)
    .filter((c) => c.type === 'string_content' || c.type === 'escape_sequence')
    .map((c) => c.text)
    .join('');
}

const firstString = (n: Node | null) => {
  const s = named(n).find((c) => c.type === 'string');
  return s ? stringValue(s) : null;
};

const SETTINGS_OBJECTS = /^(?:settings|config|cfg|conf|app_settings|get_settings\(\))\.([a-z_][a-z0-9_]*)$/;

export const pythonHooks: Hooks = {
  lang: 'python',

  calleeText(n): string {
    switch (n.type) {
      case 'identifier':
        return n.text;
      case 'attribute':
        return `${pythonHooks.calleeText(field(n, 'object')!)}.${field(n, 'attribute')?.text ?? '?'}`;
      case 'call':
        return `${pythonHooks.calleeText(field(n, 'function')!)}()`;
      case 'subscript':
        return `${pythonHooks.calleeText(field(n, 'value')!)}[]`;
      case 'parenthesized_expression':
      case 'await':
        return named(n)[0] ? pythonHooks.calleeText(named(n)[0]!) : '?';
      default:
        return collapse(n.text, 40);
    }
  },

  imports(n) {
    if (n.type === 'import_statement') {
      const out: Omit<ImportFact, 'line'>[] = [];
      for (const c of named(n)) {
        if (c.type === 'dotted_name') {
          // import a.b.c → 이름 a만 생긴다. 규칙 매칭은 전체 경로로 한다.
          const root = c.text.split('.')[0]!;
          out.push({ module: root, bindings: [{ local: root, imported: '*' }], wildcard: false, typeOnly: false });
          if (c.text !== root) out.push({ module: c.text, bindings: [], wildcard: false, typeOnly: false });
        } else if (c.type === 'aliased_import') {
          const name = field(c, 'name')!.text;
          out.push({ module: name, bindings: [{ local: field(c, 'alias')!.text, imported: '*' }], wildcard: false, typeOnly: false });
        }
      }
      return out;
    }
    if (n.type === 'import_from_statement') {
      const mod = field(n, 'module_name');
      if (!mod) return null;
      const bindings: { local: string; imported: string }[] = [];
      let wildcard = false;
      for (const c of named(n)) {
        if (c.id === mod.id) continue;
        if (c.type === 'dotted_name') bindings.push({ local: c.text, imported: c.text });
        else if (c.type === 'aliased_import') bindings.push({ local: field(c, 'alias')!.text, imported: field(c, 'name')!.text });
        else if (c.type === 'wildcard_import') wildcard = true;
      }
      return [{ module: mod.text, bindings, wildcard, typeOnly: false }];
    }
    return null;
  },

  call(n) {
    if (n.type !== 'call') return null;
    const argList = field(n, 'arguments');
    const args: Node[] = [];
    const options: [string, Node][] = [];
    for (const a of named(argList)) {
      if (a.type === 'keyword_argument') {
        const k = field(a, 'name');
        const v = field(a, 'value');
        if (k && v) options.push([k.text, v]);
      } else if (!a.type.includes('comment')) args.push(a);
    }
    return { calleeNode: field(n, 'function'), isNew: false, args, options };
  },

  decls(n) {
    switch (n.type) {
      case 'assignment': {
        const left = field(n, 'left');
        const right = field(n, 'right');
        const type = field(n, 'type')?.text;
        if (left?.type === 'identifier') return [{ name: left.text, kind: 'var', type, value: right }];
        if (left?.type === 'attribute' && ['self', 'cls'].includes(field(left, 'object')?.text ?? '')) {
          return [{ name: field(left, 'attribute')!.text, kind: 'field', type, value: right }];
        }
        return null;
      }
      // with httpx.AsyncClient() as client:
      case 'as_pattern': {
        const alias = named(field(n, 'alias'))[0] ?? field(n, 'alias');
        const value = named(n)[0];
        return alias?.type === 'identifier' && value ? [{ name: alias.text, kind: 'var', value }] : null;
      }
      case 'typed_parameter':
      case 'typed_default_parameter': {
        const name = named(n).find((c) => c.type === 'identifier');
        const type = field(n, 'type')?.text;
        return name && type ? [{ name: name.text, kind: 'param', type }] : null;
      }
      case 'function_definition': {
        const name = field(n, 'name');
        return name ? ([{ name: name.text, kind: 'function', body: field(n, 'body') }] satisfies DeclShape[]) : null;
      }
      default:
        return null;
    }
  },

  setting(n) {
    if (n.type === 'call') {
      const fn = field(n, 'function')?.text ?? '';
      if (/^os\.(?:getenv|environ\.get)$/.test(fn)) return firstString(field(n, 'arguments'));
      return null;
    }
    if (n.type === 'subscript' && field(n, 'value')?.text === 'os.environ') {
      const s = field(n, 'subscript');
      return s ? stringValue(s) : null;
    }
    if (n.type === 'attribute') {
      const m = SETTINGS_OBJECTS.exec(n.text);
      return m ? m[1]! : null;
    }
    return null;
  },

  literal: stringValue,

  parts(n) {
    if (n.type === 'string' && named(n).some((c) => c.type === 'interpolation')) {
      return named(n)
        .filter((c) => c.type === 'string_content' || c.type === 'escape_sequence' || c.type === 'interpolation')
        .map((c) => (c.type === 'interpolation' ? (field(c, 'expression') ?? named(c)[0] ?? c) : c.text));
    }
    if (n.type === 'binary_operator' && field(n, 'operator')?.text === '+') return [field(n, 'left')!, field(n, 'right')!];
    if (n.type === 'concatenated_string') return named(n);
    return null;
  },

  alts(n) {
    if (n.type === 'boolean_operator' && field(n, 'operator')?.text === 'or') return [field(n, 'left')!, field(n, 'right')!];
    if (n.type === 'conditional_expression') {
      const c = named(n);
      return c.length === 3 ? [c[0]!, c[2]!] : null;
    }
    return null;
  },

  ident(n) {
    if (n.type === 'identifier') return n.text;
    if (n.type === 'attribute' && ['self', 'cls'].includes(field(n, 'object')?.text ?? '')) return field(n, 'attribute')?.text ?? null;
    return null;
  },

  unwrap(n) {
    let cur = n;
    while ((cur.type === 'parenthesized_expression' || cur.type === 'await') && named(cur)[0]) cur = named(cur)[0]!;
    return cur;
  },

  isScope(n) {
    if (n.type !== 'function_definition') return null;
    return n.parent?.type === 'decorated_definition' ? n.parent : n;
  },

  tryBody: (n) => (n.type === 'try_statement' ? field(n, 'body') : null),

  isRef(n) {
    if (n.type === 'attribute' && ['self', 'cls'].includes(field(n, 'object')?.text ?? '')) return field(n, 'attribute')?.text ?? null;
    if (n.type !== 'identifier') return null;
    const p = n.parent;
    if (!p) return n.text;
    if (p.type === 'attribute' && field(p, 'attribute')?.id === n.id) return null;
    if (p.type === 'keyword_argument' && field(p, 'name')?.id === n.id) return null;
    if (['dotted_name', 'aliased_import', 'parameters', 'typed_parameter', 'default_parameter'].includes(p.type)) return null;
    if ((p.type === 'function_definition' || p.type === 'class_definition') && field(p, 'name')?.id === n.id) return null;
    return n.text;
  },

  className: (n) => (n.type === 'class_definition' ? (field(n, 'name')?.text ?? null) : null),
};
