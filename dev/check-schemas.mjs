/**
 * Schema conformance check for dsh-memory-bank tool definitions.
 *
 * `ctx.tools.register()` runs `assertSupportedJsonSchema` over the declared
 * parameters and output schema and THROWS on any violation. The Loader does not
 * surface that throw, so a malformed schema means the tool silently never
 * appears in the model's tool list — which is exactly how this plugin first
 * shipped a `required: true` / property-map schema that registered nothing.
 *
 * This is a faithful transliteration of
 * `@deepseek-ai/dsh-tools/lib/types/json-schema.js` (`checkSchemaNode` plus the
 * `CONSTRAINT_KEYWORDS` / `ANNOTATION_KEYWORDS` / `SCHEMA_TYPES` /
 * `ONE_OF_SIBLING_KEYWORDS` tables), kept dependency-free so it runs with plain
 * Node. It exists so that failure mode is caught here instead of in a live
 * profile.
 *
 * Usage: node dev/check-schemas.mjs
 */

import assert from 'node:assert/strict';

import { memoryBankTool, memoryPlanRitual, memoryPlanTool } from '../src/tools.js';

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/** Whether a value is a lossless JSON value, matching the harness's intrinsic test. */
function isJsonValue(value, depth = 0) {
  if (depth > 64) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type === 'object') {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
}

/** A plain JSON object usable as a schema node. */
function isSchemaRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** A plain array that is lossless JSON. */
function isPlainJsonArray(value) {
  return Array.isArray(value) && isJsonValue(value);
}

/** Whether one scalar matches a declared JSON Schema scalar type. */
function scalarMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/** Validate one object node's own fields, after its properties were visited. */
function checkObjectTail(node, path, properties, violations) {
  if (Object.hasOwn(node, 'required')) {
    const required = node.required;
    if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== 'string')) {
      violations.push(`${path}.required must be an array of strings`);
    } else {
      const declared = isSchemaRecord(properties) ? properties : {};
      for (const key of required) {
        if (!Object.hasOwn(declared, key)) {
          violations.push(`${path}.required names "${key}" which is not in properties`);
        }
      }
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`);
  }
}

/**
 * Collect every violation in one raw schema tree.
 * @param {unknown} root - the schema to check.
 * @param {string} rootPath - diagnostic root label.
 * @returns {string[]} the violations, empty when the schema is acceptable.
 */
function checkSchemaNode(root, rootPath) {
  const violations = [];
  const tasks = [{ kind: 'enter', node: root, path: rootPath }];
  const seen = new Set();
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      seen.delete(task.node);
      continue;
    }
    if (task.kind === 'one-of-tail') {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
      }
      continue;
    }
    if (task.kind === 'object-tail') {
      checkObjectTail(task.node, task.path, task.properties, violations);
      continue;
    }
    const { node, path } = task;
    if (!isSchemaRecord(node)) {
      violations.push(`${path} must be a schema object`);
      continue;
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`);
      continue;
    }
    seen.add(node);
    tasks.push({ kind: 'leave', node });
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue;
      if (ANNOTATION_KEYWORDS.has(key)) {
        if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
        continue;
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`);
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`);
    }
    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`);
      continue;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
      }
      continue;
    }
    if (hasOneOf) {
      tasks.push({ kind: 'one-of-tail', node, path });
      if (!isPlainJsonArray(node.oneOf) || node.oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`);
      } else {
        for (let index = node.oneOf.length - 1; index >= 0; index -= 1) {
          tasks.push({ kind: 'enter', node: node.oneOf[index], path: `${path}.oneOf[${index}]` });
        }
      }
      continue;
    }
    const schemaType = node.type;
    if (typeof schemaType !== 'string' || !SCHEMA_TYPES.includes(schemaType)) {
      violations.push(Array.isArray(schemaType)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
      continue;
    }
    const allowedFor = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    };
    for (const [key, types] of Object.entries(allowedFor)) {
      if (Object.hasOwn(node, key) && !types.includes(schemaType)) {
        violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
      }
    }
    switch (schemaType) {
      case 'object': {
        const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined;
        tasks.push({ kind: 'object-tail', node, path, properties });
        if (Object.hasOwn(node, 'properties')) {
          if (!isSchemaRecord(properties)) {
            violations.push(`${path}.properties must be an object of schemas`);
          } else {
            const entries = Object.entries(properties);
            for (let index = entries.length - 1; index >= 0; index -= 1) {
              tasks.push({ kind: 'enter', node: entries[index][1], path: `${path}.properties.${entries[index][0]}` });
            }
          }
        }
        break;
      }
      case 'array': {
        if (Object.hasOwn(node, 'items')) tasks.push({ kind: 'enter', node: node.items, path: `${path}.items` });
        break;
      }
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null': {
        const hasEnum = Object.hasOwn(node, 'enum');
        const allowed = hasEnum ? node.enum : undefined;
        const enumValid = isPlainJsonArray(allowed)
          && allowed.length > 0
          && allowed.every((entry) => scalarMatches(schemaType, entry));
        if (hasEnum && !enumValid) {
          violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
        }
        const hasConst = Object.hasOwn(node, 'const');
        const constValid = scalarMatches(schemaType, node.const);
        if (hasConst) {
          if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
          else if (enumValid && !allowed.includes(node.const)) {
            violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
          }
        }
        break;
      }
      default: break;
    }
  }
  return violations;
}

/** Assert one schema and report every violation. */
function check(label, schema) {
  const violations = checkSchemaNode(schema, label);
  assert.deepEqual(violations, [], `${label}:\n  ${violations.join('\n  ')}`);
  console.log(`OK   ${label}`);
}

const bank = memoryBankTool();
const plan = memoryPlanTool();

check('memory_bank.parameters', bank.parameters);
check('memory_bank.output.schema', bank.output.schema);
check('memory_plan.parameters', plan.parameters);
check('memory_plan.output.schema', plan.output.schema);

// The specific mistake this check exists to catch, kept as a regression probe.
{
  const wrong = { type: 'object', properties: { action: { type: 'string', required: true } } };
  assert.ok(
    checkSchemaNode(wrong, 'wrong').length > 0,
    'the DSL-style `required: true` spelling must be reported as a violation',
  );
  console.log('OK   regression probe: `required: true` inside a property is rejected');
}

// Parameters must be object-rooted with a required list, since the registry
// validates arguments against them.
for (const [label, definition] of [['memory_bank', bank], ['memory_plan', plan]]) {
  assert.equal(definition.parameters.type, 'object', `${label} parameters are object-rooted`);
  assert.ok(Array.isArray(definition.parameters.required), `${label} declares required as an array`);
  assert.equal(definition.parameters.additionalProperties, false, `${label} rejects unknown arguments`);
  assert.equal(typeof definition.output.render, 'function', `${label} declares output.render`);
  assert.equal(typeof definition.description, 'string');
  assert.ok(definition.description.length > 0);
}

assert.deepEqual(bank.parameters.required, ['action']);
assert.ok(bank.parameters.properties.action.enum.includes('status'));
assert.deepEqual(plan.parameters.required, [], 'memory_plan takes no arguments');
assert.deepEqual(Object.keys(plan.parameters.properties), []);
assert.match(memoryPlanRitual(), /Memory Bank update ritual/);

// The definition handed to the registry must carry exactly the keys the registry
// consumes; an extra field is a sign of accidental surface area.
const ALLOWED_DEFINITION_KEYS = new Set([
  'name', 'description', 'parameters', 'output', 'timeoutMs',
  'isConcurrencySafe', 'presentCall', 'presentResult',
]);
for (const [label, definition] of [['memory_bank', bank], ['memory_plan', plan]]) {
  const extra = Object.keys(definition).filter((key) => !ALLOWED_DEFINITION_KEYS.has(key));
  assert.deepEqual(extra, [], `${label} carries unexpected definition keys: ${extra.join(', ')}`);
}

// Every enum value must be reachable: the actions the executor switch handles.
const handled = ['status', 'read', 'write', 'append', 'list', 'grep', 'init', 'sync'];
assert.deepEqual([...bank.parameters.properties.action.enum].sort(), [...handled].sort());

// Every property the renderer reads must be declared, or the success result fails
// validation at dispatch instead of rendering.
const DECLARED_RESULT_KEYS = new Set(Object.keys(bank.output.schema.properties));
for (const key of ['action', 'ok', 'folder', 'root', 'initialized', 'focus', 'file', 'bytes', 'count', 'created', 'text', 'truncated', 'changed', 'kept', 'gitignore', 'matches', 'files']) {
  assert.ok(DECLARED_RESULT_KEYS.has(key), `result schema does not declare \`${key}\``);
}

console.log('\nAll schema conformance checks passed.');
