'use strict';
const { z } = require('zod');
function normalize(schema, value) {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable)
    return normalize(schema._def.innerType, value);
  if (typeof value === 'string') {
    if (schema instanceof z.ZodBoolean && ['true', 'false'].includes(value)) return value === 'true';
    if (schema instanceof z.ZodNumber && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
      const n = Number(value); return Number.isFinite(n) ? n : value;
    }
    if (schema instanceof z.ZodObject || schema instanceof z.ZodArray) {
      try { value = JSON.parse(value); } catch { return value; }
    }
  }
  if (schema instanceof z.ZodObject && value && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, schema.shape[key] ? normalize(schema.shape[key], v) : v]));
  if (schema instanceof z.ZodArray && Array.isArray(value)) return value.map(v => normalize(schema.element, v));
  return value;
}
function compatible(shape) {
  shape = { owner: z.string().trim().min(1).optional().describe('Метка сеанса владельца.'),
    work: z.string().trim().min(1).optional().describe('Связанная работа.'), ...shape };
  return Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key,
    z.preprocess(value => normalize(schema, value), schema).describe(schema.description || '')]));
}
module.exports = { compatible };
