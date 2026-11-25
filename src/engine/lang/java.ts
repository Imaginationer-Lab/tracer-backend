import { collapse, field, named, stripGenerics, type DeclShape, type Hooks, type Node } from '../syntax.js';

function stringValue(n: Node): string | null {
  if (n.type === 'string_literal') {
    const kids = named(n);
    return kids.length ? kids.map((c) => c.text).join('') : n.text.replace(/^"|"$/g, '');
  }
  if (n.type === 'text_block') return n.text.replace(/^"""|"""$/g, '').trim();
  return null;
}

/** @Value("${payment.url:default}") → payment.url */
function annotationSetting(a: Node): string | null {
  const name = field(a, 'name')?.text;
  const args = named(field(a, 'arguments'));
  if (name === 'Value') {
    const s = args[0] ? stringValue(args[0]) : null;
    const m = s ? /^\$\{([^:}]+)/.exec(s) : null;
    return m ? m[1]! : null;
  }
  if (name === 'ConfigurationProperties') {
    const direct = args[0] ? stringValue(args[0]) : null;
    if (direct) return direct;
    const pair = args.find((p) => p.type === 'element_value_pair' && ['prefix', 'value'].includes(field(p, 'key')?.text ?? ''));
    const v = pair ? field(pair, 'value') : null;
    return v ? stringValue(v) : null;
  }
  return null;
}

const modifiersSetting = (n: Node) => {
  const mods = named(n).find((c) => c.type === 'modifiers');
  for (const a of named(mods)) if (a.type === 'annotation') return annotationSetting(a);
  return null;
};

export const javaHooks: Hooks = {
  lang: 'java',

  calleeText(n): string {
    switch (n.type) {
      case 'identifier':
      case 'type_identifier':
      case 'scoped_identifier':
      case 'scoped_type_identifier':
        return n.text;
      case 'this':
        return 'this';
      case 'field_access':
        return `${javaHooks.calleeText(field(n, 'object')!)}.${field(n, 'field')?.text ?? '?'}`;
      case 'method_invocation': {
        const obj = field(n, 'object');
        return `${obj ? `${javaHooks.calleeText(obj)}.` : ''}${field(n, 'name')?.text ?? '?'}()`;
      }
      case 'object_creation_expression':
        return `${stripGenerics(field(n, 'type')?.text ?? '?')}()`;
      case 'parenthesized_expression':
        return named(n)[0] ? javaHooks.calleeText(named(n)[0]!) : '?';
      default:
        return collapse(n.text, 40);
    }
  },

  imports(n) {
    if (n.type !== 'import_declaration') return null;
    const m = /^import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(n.text.replace(/\s+/g, ' '));
    if (!m) return null;
    const module = m[2]!;
    if (m[3]) return [{ module, bindings: [], wildcard: true, typeOnly: false }];
    return [{ module, bindings: [{ local: module.split('.').pop()!, imported: '*' }], wildcard: false, typeOnly: false }];
  },

  call(n) {
    if (n.type === 'method_invocation') {
      const obj = field(n, 'object');
      const calleeText = `${obj ? `${javaHooks.calleeText(obj)}.` : ''}${field(n, 'name')?.text ?? '?'}`;
      return { calleeNode: null, calleeText, isNew: false, args: named(field(n, 'arguments')), options: [] };
    }
    if (n.type === 'object_creation_expression') {
      return { calleeNode: null, calleeText: stripGenerics(field(n, 'type')?.text ?? '?'), isNew: true, args: named(field(n, 'arguments')), options: [] };
    }
    // @FeignClient(url = "${partner.url}") 같은 어노테이션도 호출처럼 다룬다
    if (n.type === 'annotation') {
      const args = named(field(n, 'arguments'));
      const options: [string, Node][] = [];
      for (const p of args) {
        if (p.type === 'element_value_pair') {
          const k = field(p, 'key');
          const v = field(p, 'value');
          if (k && v) options.push([k.text, v]);
        }
      }
      return { calleeNode: null, calleeText: field(n, 'name')?.text ?? '?', isNew: false, args: args.filter((a) => a.type !== 'element_value_pair'), options };
    }
    return null;
  },

  decls(n) {
    switch (n.type) {
      case 'field_declaration':
      case 'local_variable_declaration':
      case 'constant_declaration': {
        const type = field(n, 'type')?.text;
        const setting = modifiersSetting(n) ?? undefined;
        const kind = n.type === 'local_variable_declaration' ? 'var' : 'field';
        return named(n)
          .filter((d) => d.type === 'variable_declarator')
          .map((d): DeclShape => ({ name: field(d, 'name')!.text, kind, type: type === 'var' ? undefined : type, value: field(d, 'value'), setting }));
      }
      case 'formal_parameter': {
        const name = field(n, 'name');
        return name ? [{ name: name.text, kind: 'param', type: field(n, 'type')?.text, setting: modifiersSetting(n) ?? undefined }] : null;
      }
      case 'method_declaration':
      case 'constructor_declaration': {
        const name = field(n, 'name');
        return name ? [{ name: name.text, kind: 'function', body: field(n, 'body') }] : null;
      }
      case 'assignment_expression': {
        // this.s3 = s3;
        const left = field(n, 'left');
        if (left?.type === 'field_access' && field(left, 'object')?.type === 'this') {
          return [{ name: field(left, 'field')!.text, kind: 'field', value: field(n, 'right') }];
        }
        return null;
      }
      default:
        return null;
    }
  },

  setting(n) {
    if (n.type === 'annotation') return annotationSetting(n);
    // "${partner.shipping-url}" 같은 Spring 자리표시자 문자열
    if (n.type === 'string_literal') {
      const m = /^\$\{([^:}]+)(?::[^}]*)?\}$/.exec(stringValue(n) ?? '');
      return m ? m[1]! : null;
    }
    if (n.type === 'method_invocation') {
      const callee = `${field(n, 'object')?.text ?? ''}.${field(n, 'name')?.text ?? ''}`;
      if (callee === 'System.getenv' || /\.getProperty$/.test(callee) || /\.getRequiredProperty$/.test(callee)) {
        const a = named(field(n, 'arguments'))[0];
        return a ? stringValue(a) : null;
      }
    }
    return null;
  },

  literal: stringValue,

  parts: (n) => (n.type === 'binary_expression' && field(n, 'operator')?.text === '+' ? [field(n, 'left')!, field(n, 'right')!] : null),

  alts: (n) => (n.type === 'ternary_expression' ? [field(n, 'consequence')!, field(n, 'alternative')!] : null),

  ident(n) {
    if (n.type === 'identifier') return n.text;
    if (n.type === 'field_access' && field(n, 'object')?.type === 'this') return field(n, 'field')?.text ?? null;
    return null;
  },

  unwrap(n) {
    let cur = n;
    while (cur.type === 'parenthesized_expression' || cur.type === 'cast_expression') {
      const inner = cur.type === 'cast_expression' ? field(cur, 'value') : named(cur)[0];
      if (!inner) break;
      cur = inner;
    }
    return cur;
  },

  isScope: (n) => (['method_declaration', 'constructor_declaration', 'lambda_expression'].includes(n.type) ? n : null),

  tryBody: (n) => (n.type === 'try_statement' || n.type === 'try_with_resources_statement' ? field(n, 'body') : null),

  isRef(n) {
    if (n.type === 'field_access' && field(n, 'object')?.type === 'this') return field(n, 'field')?.text ?? null;
    if (n.type !== 'identifier') return null;
    const p = n.parent;
    if (!p) return n.text;
    if (p.type === 'method_invocation' && field(p, 'name')?.id === n.id) return null;
    if (p.type === 'field_access' && field(p, 'field')?.id === n.id) return null;
    if (field(p, 'name')?.id === n.id && p.type !== 'method_invocation') return null;
    return n.text;
  },

  className: (n) =>
    ['class_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration'].includes(n.type) ? (field(n, 'name')?.text ?? null) : null,
};
