import { collapse, field, named, stripGenerics, type DeclShape, type Hooks, type Node } from '../syntax.js';

function stringValue(n: Node): string | null {
  if (n.type === 'string_literal') {
    const kids = named(n).filter((c) => c.type === 'string_literal_content' || c.type === 'escape_sequence');
    return kids.length ? kids.map((c) => c.text).join('') : n.text.replace(/^"|"$/g, '');
  }
  if (n.type === 'verbatim_string_literal') return n.text.slice(2, -1);
  if (n.type === 'raw_string_literal') return n.text.replace(/^"+|"+$/g, '');
  return null;
}

/** argument 노드에서 식만 꺼낸다 (이름 붙은 인자 name: value 포함) */
function argExpr(a: Node): Node | null {
  const kids = named(a);
  const name = field(a, 'name');
  return kids.find((k) => k.id !== name?.id) ?? null;
}

const nameOf = (n: Node | null): string => (n?.type === 'generic_name' ? (named(n)[0]?.text ?? n.text) : (n?.text ?? '?'));

const CONFIG_OBJECT = /(?:^|\.)_?(?:config|configuration|settings)$/i;

export const csharpHooks: Hooks = {
  lang: 'csharp',

  calleeText(n): string {
    switch (n.type) {
      case 'identifier':
      case 'qualified_name':
      case 'predefined_type':
        return n.text;
      case 'generic_name':
        return nameOf(n);
      case 'this_expression':
      case 'this':
        return 'this';
      case 'member_access_expression':
        return `${csharpHooks.calleeText(field(n, 'expression')!)}.${nameOf(field(n, 'name'))}`;
      case 'invocation_expression':
        return `${csharpHooks.calleeText(field(n, 'function')!)}()`;
      case 'object_creation_expression':
        return `${stripGenerics(field(n, 'type')?.text ?? '?')}()`;
      case 'element_access_expression':
        return `${csharpHooks.calleeText(field(n, 'expression')!)}[]`;
      case 'parenthesized_expression':
      case 'await_expression':
        return named(n)[0] ? csharpHooks.calleeText(named(n)[0]!) : '?';
      default:
        return collapse(n.text, 40);
    }
  },

  imports(n) {
    if (n.type !== 'using_directive') return null;
    const m = /^(?:global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/.exec(n.text.replace(/\s+/g, ' '));
    if (!m) return null;
    const module = m[3]!;
    if (m[2]) return [{ module, bindings: [{ local: m[2], imported: '*' }], wildcard: false, typeOnly: false }];
    return [{ module, bindings: [], wildcard: true, typeOnly: false }];
  },

  call(n) {
    if (n.type === 'invocation_expression') {
      const args: Node[] = [];
      const options: [string, Node][] = [];
      for (const a of named(field(n, 'arguments'))) {
        const expr = argExpr(a);
        if (!expr) continue;
        const name = field(a, 'name');
        if (name) options.push([name.text, expr]);
        else args.push(expr);
      }
      return { calleeNode: field(n, 'function'), isNew: false, args, options };
    }
    if (n.type === 'object_creation_expression') {
      const args = named(field(n, 'arguments')).map(argExpr).filter((x): x is Node => x !== null);
      // new HttpClient { BaseAddress = new Uri(...) }
      const options: [string, Node][] = [];
      for (const a of named(field(n, 'initializer'))) {
        if (a.type === 'assignment_expression') {
          const l = field(a, 'left');
          const r = field(a, 'right');
          if (l && r) options.push([l.text, r]);
        }
      }
      return { calleeNode: null, calleeText: stripGenerics(field(n, 'type')?.text ?? '?'), isNew: true, args, options };
    }
    return null;
  },

  decls(n) {
    switch (n.type) {
      case 'variable_declaration': {
        const typeNode = field(n, 'type');
        const type = typeNode && typeNode.type !== 'implicit_type' ? typeNode.text : undefined;
        const kind = n.parent?.type === 'field_declaration' ? 'field' : 'var';
        return named(n)
          .filter((d) => d.type === 'variable_declarator')
          .map((d): DeclShape => {
            const name = field(d, 'name') ?? named(d)[0]!;
            const value = named(d).find((c) => c.id !== name.id && c.type !== 'bracketed_argument_list') ?? null;
            return { name: name.text, kind, type, value };
          });
      }
      case 'property_declaration': {
        const name = field(n, 'name');
        return name ? [{ name: name.text, kind: 'field', type: field(n, 'type')?.text, value: field(n, 'value') }] : null;
      }
      case 'parameter': {
        const name = field(n, 'name');
        const type = field(n, 'type')?.text;
        return name && type ? [{ name: name.text, kind: 'param', type }] : null;
      }
      case 'method_declaration':
      case 'constructor_declaration':
      case 'local_function_statement': {
        const name = field(n, 'name');
        return name ? [{ name: name.text, kind: 'function', body: field(n, 'body') }] : null;
      }
      case 'assignment_expression': {
        // _s3 = s3;  this._http = http;
        const left = field(n, 'left');
        const right = field(n, 'right');
        if (left?.type === 'identifier') return [{ name: left.text, kind: 'field', value: right }];
        if (left?.type === 'member_access_expression' && field(left, 'expression')?.type === 'this_expression') {
          return [{ name: nameOf(field(left, 'name')), kind: 'field', value: right }];
        }
        return null;
      }
      default:
        return null;
    }
  },

  setting(n) {
    if (n.type === 'invocation_expression') {
      const fn = field(n, 'function');
      const method = fn?.type === 'member_access_expression' ? nameOf(field(fn, 'name')) : nameOf(fn);
      if (['GetEnvironmentVariable', 'GetValue', 'GetConnectionString', 'GetSection', 'GetRequiredSection'].includes(method)) {
        const first = named(field(n, 'arguments'))[0];
        const expr = first ? argExpr(first) : null;
        return expr ? stringValue(expr) : null;
      }
      return null;
    }
    // _config["Supabase:Url"] · builder.Configuration["..."]
    if (n.type === 'element_access_expression' && CONFIG_OBJECT.test(field(n, 'expression')?.text ?? '')) {
      const arg = named(field(n, 'subscript'))[0];
      const expr = arg ? argExpr(arg) : null;
      return expr ? stringValue(expr) : null;
    }
    return null;
  },

  literal: stringValue,

  parts(n) {
    if (n.type === 'interpolated_string_expression') {
      return named(n)
        .filter((c) => c.type === 'string_content' || c.type === 'interpolation' || c.type === 'escape_sequence')
        .map((c) => (c.type === 'interpolation' ? (named(c).find((x) => !x.type.startsWith('interpolation_')) ?? c) : c.text));
    }
    if (n.type === 'binary_expression' && field(n, 'operator')?.text === '+') return [field(n, 'left')!, field(n, 'right')!];
    return null;
  },

  alts(n) {
    if (n.type === 'binary_expression' && field(n, 'operator')?.text === '??') return [field(n, 'left')!, field(n, 'right')!];
    if (n.type === 'conditional_expression') return [field(n, 'consequence')!, field(n, 'alternative')!];
    return null;
  },

  ident(n) {
    if (n.type === 'identifier') return n.text;
    if (n.type === 'member_access_expression' && field(n, 'expression')?.type === 'this_expression') return nameOf(field(n, 'name'));
    return null;
  },

  unwrap(n) {
    let cur = n;
    for (;;) {
      if (['parenthesized_expression', 'await_expression'].includes(cur.type) && named(cur)[0]) cur = named(cur)[0]!;
      else if (cur.type === 'cast_expression' && field(cur, 'value')) cur = field(cur, 'value')!;
      else if (cur.type === 'postfix_unary_expression' && cur.text.endsWith('!') && named(cur)[0]) cur = named(cur)[0]!;
      else return cur;
    }
  },

  isScope: (n) => (['method_declaration', 'constructor_declaration', 'local_function_statement', 'lambda_expression'].includes(n.type) ? n : null),

  tryBody: (n) => (n.type === 'try_statement' ? field(n, 'body') : null),

  isRef(n) {
    if (n.type === 'member_access_expression' && field(n, 'expression')?.type === 'this_expression') return nameOf(field(n, 'name'));
    if (n.type !== 'identifier') return null;
    const p = n.parent;
    if (!p) return n.text;
    if (p.type === 'member_access_expression' && field(p, 'name')?.id === n.id) return null;
    if (p.type === 'generic_name' || p.type === 'qualified_name') return null;
    if (['variable_declarator', 'parameter', 'method_declaration', 'class_declaration', 'property_declaration'].includes(p.type) && field(p, 'name')?.id === n.id) return null;
    return n.text;
  },

  className: (n) =>
    ['class_declaration', 'record_declaration', 'interface_declaration', 'struct_declaration'].includes(n.type) ? (field(n, 'name')?.text ?? null) : null,
};
