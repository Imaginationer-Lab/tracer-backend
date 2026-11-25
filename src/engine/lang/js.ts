import { collapse, field, named, type Hooks, type Node } from '../syntax.js';
import type { Lang } from '../types.js';

const unquote = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

function stringValue(n: Node): string | null {
  if (n.type === 'string') return named(n).map((c) => c.text).join('');
  if (n.type === 'template_string' && !named(n).some((c) => c.type === 'template_substitution')) {
    return named(n).map((c) => c.text).join('');
  }
  return null;
}

function objectOptions(obj: Node | undefined): [string, Node][] {
  if (!obj || obj.type !== 'object') return [];
  const out: [string, Node][] = [];
  for (const c of named(obj)) {
    if (c.type === 'pair') {
      const k = field(c, 'key');
      const v = field(c, 'value');
      if (k && v) out.push([unquote(k.text), v]);
    } else if (c.type === 'shorthand_property_identifier') out.push([c.text, c]);
  }
  return out;
}

function isThis(n: Node | null) {
  return n?.type === 'this';
}

export function jsHooks(lang: Lang): Hooks {
  const calleeText = (n: Node): string => {
    switch (n.type) {
      case 'identifier':
      case 'property_identifier':
      case 'private_property_identifier':
        return n.text;
      case 'this':
        return 'this';
      case 'member_expression':
        return `${calleeText(field(n, 'object')!)}.${field(n, 'property')?.text ?? '?'}`;
      case 'subscript_expression':
        return `${calleeText(field(n, 'object')!)}[]`;
      case 'call_expression':
        return `${calleeText(field(n, 'function')!)}()`;
      case 'new_expression':
        return `${calleeText(field(n, 'constructor')!)}()`;
      case 'parenthesized_expression':
      case 'non_null_expression':
      case 'await_expression':
        return named(n)[0] ? calleeText(named(n)[0]!) : '?';
      default:
        return collapse(n.text, 40);
    }
  };

  return {
    lang,
    calleeText,

    imports(n) {
      if (n.type === 'import_statement') {
        const source = field(n, 'source');
        if (!source) return null;
        const typeOnly = /^import\s+type\b/.test(n.text);
        const bindings: { local: string; imported: string }[] = [];
        const clause = named(n).find((c) => c.type === 'import_clause');
        for (const c of named(clause)) {
          if (c.type === 'identifier') bindings.push({ local: c.text, imported: 'default' });
          else if (c.type === 'namespace_import') {
            const id = named(c)[0];
            if (id) bindings.push({ local: id.text, imported: '*' });
          } else if (c.type === 'named_imports') {
            for (const spec of named(c)) {
              if (spec.type !== 'import_specifier' || /^type\s/.test(spec.text)) continue;
              const name = field(spec, 'name');
              const alias = field(spec, 'alias');
              if (name) bindings.push({ local: (alias ?? name).text, imported: name.text });
            }
          }
        }
        return [{ module: stringValue(source) ?? unquote(source.text), bindings, wildcard: false, typeOnly }];
      }
      if (n.type === 'export_statement' && field(n, 'source')) {
        return [{ module: stringValue(field(n, 'source')!) ?? '', bindings: [], wildcard: false, typeOnly: /^export\s+type\b/.test(n.text) }];
      }
      if (n.type === 'call_expression') {
        const fn = field(n, 'function');
        const arg = named(field(n, 'arguments'))[0];
        const isRequire = fn?.type === 'identifier' && fn.text === 'require';
        if ((!isRequire && fn?.type !== 'import') || !arg) return null;
        const module = stringValue(arg);
        if (module === null) return null;
        // const x = require('m') · const { a, b: c } = require('m') · const m = await import('m')
        let p = n.parent;
        while (p && (p.type === 'await_expression' || p.type === 'parenthesized_expression')) p = p.parent;
        const bindings: { local: string; imported: string }[] = [];
        const target = p?.type === 'variable_declarator' ? field(p, 'name') : null;
        if (target?.type === 'identifier') bindings.push({ local: target.text, imported: '*' });
        else if (target?.type === 'object_pattern') {
          for (const c of named(target)) {
            if (c.type === 'shorthand_property_identifier_pattern') bindings.push({ local: c.text, imported: c.text });
            else if (c.type === 'pair_pattern') {
              const k = field(c, 'key');
              const v = field(c, 'value');
              if (k && v) bindings.push({ local: v.text, imported: k.text });
            }
          }
        }
        return [{ module, bindings, wildcard: false, typeOnly: false }];
      }
      return null;
    },

    call(n) {
      if (n.type === 'call_expression') {
        const fn = field(n, 'function');
        if (!fn || fn.type === 'import' || (fn.type === 'identifier' && fn.text === 'require')) return null;
        const args = named(field(n, 'arguments')).filter((a) => !a.type.includes('comment'));
        return { calleeNode: fn, isNew: false, args, options: objectOptions(args.find((a) => a.type === 'object')) };
      }
      if (n.type === 'new_expression') {
        const ctor = field(n, 'constructor');
        const args = named(field(n, 'arguments')).filter((a) => !a.type.includes('comment'));
        return { calleeNode: ctor, isNew: true, args, options: objectOptions(args.find((a) => a.type === 'object')) };
      }
      return null;
    },

    decls(n) {
      const typeOf = (x: Node) => named(field(x, 'type'))[0]?.text;
      switch (n.type) {
        case 'variable_declarator': {
          const name = field(n, 'name');
          if (name?.type !== 'identifier') return null;
          return [{ name: name.text, kind: 'var', type: typeOf(n), value: field(n, 'value') }];
        }
        case 'public_field_definition': {
          const name = field(n, 'name');
          return name ? [{ name: name.text, kind: 'field', type: typeOf(n), value: field(n, 'value') }] : null;
        }
        case 'required_parameter':
        case 'optional_parameter': {
          const pattern = field(n, 'pattern');
          const type = typeOf(n);
          return pattern?.type === 'identifier' && type ? [{ name: pattern.text, kind: 'param', type }] : null;
        }
        case 'function_declaration':
        case 'generator_function_declaration':
        case 'method_definition': {
          const name = field(n, 'name');
          return name ? [{ name: name.text, kind: 'function', body: field(n, 'body') }] : null;
        }
        case 'assignment_expression': {
          const left = field(n, 'left');
          const right = field(n, 'right');
          if (left?.type === 'member_expression' && isThis(field(left, 'object'))) {
            return [{ name: field(left, 'property')!.text, kind: 'field', value: right }];
          }
          if (left?.type === 'identifier') return [{ name: left.text, kind: 'var', value: right }];
          // exports.stripe = new Stripe(...)
          const m = /^(?:module\.)?exports\.(\w+)$/.exec(left?.text ?? '');
          if (m && right && right.type !== 'identifier') return [{ name: m[1]!, kind: 'var', value: right }];
          return null;
        }
        case 'export_statement': {
          // export default new Stripe(...)
          const value = field(n, 'value');
          return value && value.type !== 'identifier' ? [{ name: 'default', kind: 'var', value }] : null;
        }
        default:
          return null;
      }
    },

    isExported: (n) => n.type === 'export_statement',

    exportAliases(n) {
      if (n.type === 'export_statement' && !field(n, 'source')) {
        const value = field(n, 'value');
        if (value?.type === 'identifier') return [{ local: value.text, exported: 'default' }];
        const clause = named(n).find((c) => c.type === 'export_clause');
        if (!clause) return null;
        return named(clause)
          .filter((s) => s.type === 'export_specifier')
          .map((s) => ({ local: field(s, 'name')!.text, exported: (field(s, 'alias') ?? field(s, 'name')!).text }));
      }
      if (n.type === 'assignment_expression') {
        const left = field(n, 'left')?.text ?? '';
        const right = field(n, 'right');
        if (!right) return null;
        if (left === 'module.exports') {
          if (right.type === 'identifier') return [{ local: right.text, exported: 'default' }];
          if (right.type === 'object') {
            return named(right).flatMap((c) =>
              c.type === 'shorthand_property_identifier'
                ? [{ local: c.text, exported: c.text }]
                : c.type === 'pair' && field(c, 'value')?.type === 'identifier'
                  ? [{ local: field(c, 'value')!.text, exported: unquote(field(c, 'key')!.text) }]
                  : [],
            );
          }
        }
        const m = /^(?:module\.)?exports\.(\w+)$/.exec(left);
        if (m && right.type === 'identifier') return [{ local: right.text, exported: m[1]! }];
      }
      return null;
    },

    setting(n) {
      if (n.type === 'member_expression') {
        const m = /^(?:process\.env|import\.meta\.env)\.([A-Za-z_]\w*)$/.exec(n.text) ?? /^env\.([A-Z][A-Z0-9_]*)$/.exec(n.text);
        return m ? m[1]! : null;
      }
      if (n.type === 'subscript_expression') {
        const m = /^process\.env\[\s*['"`]([^'"`]+)['"`]\s*\]$/.exec(n.text);
        return m ? m[1]! : null;
      }
      // SvelteKit: import { PUBLIC_SUPABASE_URL } from '$env/static/public'
      if (n.type === 'import_specifier') {
        const stmt = n.parent?.parent?.parent;
        if (stmt?.type === 'import_statement' && /\$env\/static\//.test(field(stmt, 'source')?.text ?? '')) return field(n, 'name')?.text ?? null;
      }
      return null;
    },

    literal: stringValue,

    parts(n) {
      if (n.type === 'template_string' && named(n).some((c) => c.type === 'template_substitution')) {
        return named(n).map((c) => (c.type === 'template_substitution' ? named(c)[0] ?? c : c.text));
      }
      if (n.type === 'binary_expression' && field(n, 'operator')?.text === '+') return [field(n, 'left')!, field(n, 'right')!];
      return null;
    },

    alts(n) {
      if (n.type === 'binary_expression' && ['??', '||'].includes(field(n, 'operator')?.text ?? '')) return [field(n, 'left')!, field(n, 'right')!];
      if (n.type === 'ternary_expression') return [field(n, 'consequence')!, field(n, 'alternative')!];
      return null;
    },

    ident(n) {
      if (n.type === 'identifier' || n.type === 'shorthand_property_identifier') return n.text;
      if (n.type === 'member_expression' && isThis(field(n, 'object'))) return field(n, 'property')?.text ?? null;
      return null;
    },

    unwrap(n) {
      let cur = n;
      while (['parenthesized_expression', 'await_expression', 'non_null_expression', 'as_expression', 'satisfies_expression', 'type_assertion'].includes(cur.type)) {
        const inner = named(cur)[0];
        if (!inner) break;
        cur = inner;
      }
      return cur;
    },

    isScope: (n) =>
      ['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration', 'function'].includes(n.type) ? n : null,

    tryBody: (n) => (n.type === 'try_statement' ? field(n, 'body') : null),

    isRef(n) {
      if (n.type === 'shorthand_property_identifier') return n.text;
      if (n.type === 'member_expression' && isThis(field(n, 'object'))) return field(n, 'property')?.text ?? null;
      if (n.type !== 'identifier') return null;
      const p = n.parent;
      if (!p) return n.text;
      if (['import_specifier', 'import_clause', 'namespace_import', 'export_specifier'].includes(p.type)) return null;
      if (field(p, 'name')?.id === n.id || field(p, 'pattern')?.id === n.id) return null;
      return n.text;
    },

    className: (n) => (n.type === 'class_declaration' || n.type === 'abstract_class_declaration' ? (field(n, 'name')?.text ?? null) : null),
  };
}
