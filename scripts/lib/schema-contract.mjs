// Deliberately bounded JSON Schema dialect for checked-in repository contracts.
// Unknown validation keywords fail, rather than silently claiming validation.
import assert from "node:assert/strict";
const annotations=new Set(["$schema","$id","title","description","default","examples","$comment"]);
const supported=new Set(["type","const","enum","properties","required","additionalProperties","items","minItems","maxItems","minLength","maxLength","minimum","maximum","exclusiveMinimum","exclusiveMaximum","pattern","format","anyOf"]);
export function validateContract(schema,value,path="$",definitionOnly=false) {
  if(typeof schema!=="object"||schema===null||Array.isArray(schema)) throw new Error(`${path}: schema object required`);
  for(const key of Object.keys(schema)) if(!annotations.has(key)&&!supported.has(key)) throw new Error(`${path}: unsupported schema keyword ${key}`);
  // Inspect every branch, including absent optional properties.
  for(const [key,child] of Object.entries(schema.properties||{})) validateContract(child,undefined,`${path}.${key}`,true);
  if(schema.items) validateContract(schema.items,undefined,`${path}[]`,true);
  for(const branch of schema.anyOf||[]) validateContract(branch,undefined,path,true);
  if(schema.additionalProperties && typeof schema.additionalProperties==="object") validateContract(schema.additionalProperties,undefined,path,true);
  if(definitionOnly) return true;
  const fail=reason=>{throw new Error(`${path}: ${reason}`);};
  if(schema.anyOf && !schema.anyOf.some(s=>{try {validateContract(s,value,path);return true;}catch{return false;}})) fail("no anyOf branch matched");
  const types={object:v=>v!==null&&typeof v==="object"&&!Array.isArray(v),array:Array.isArray,string:v=>typeof v==="string",number:v=>typeof v==="number"&&Number.isFinite(v),integer:Number.isSafeInteger,boolean:v=>typeof v==="boolean",null:v=>v===null};
  if(schema.type && ![].concat(schema.type).some(t=>types[t]?.(value))) fail(`expected ${schema.type}`);
  if(Object.hasOwn(schema,"const")) {try{assert.deepEqual(value,schema.const);}catch{fail("const mismatch");}}
  if(schema.enum && !schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value))) fail("enum mismatch");
  if(typeof value==="number") for(const [key,predicate] of Object.entries({minimum:v=>value>=v,maximum:v=>value<=v,exclusiveMinimum:v=>value>v,exclusiveMaximum:v=>value<v})) if(schema[key]!=null&&!predicate(schema[key])) fail(key);
  if(typeof value==="string") {
    if(schema.minLength!=null&&value.length<schema.minLength) fail("minLength");
    if(schema.maxLength!=null&&value.length>schema.maxLength) fail("maxLength");
    if(schema.pattern&&!new RegExp(schema.pattern).test(value)) fail("pattern");
    if(schema.format==="date"&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)) fail("invalid date");
    if(schema.format && schema.format!=="date") fail(`unsupported format ${schema.format}`);
  }
  if(Array.isArray(value)) {
    if(schema.minItems!=null&&value.length<schema.minItems) fail("minItems");
    if(schema.maxItems!=null&&value.length>schema.maxItems) fail("maxItems");
    value.forEach((v,i)=>{if(schema.items) validateContract(schema.items,v,`${path}[${i}]`);});
  } else if(value&&typeof value==="object") {
    for(const key of schema.required||[]) if(!Object.hasOwn(value,key)) fail(`missing ${key}`);
    for(const [key,v] of Object.entries(value)) {
      if(schema.properties?.[key]) validateContract(schema.properties[key],v,`${path}.${key}`);
      else if(schema.additionalProperties===false) fail(`unknown property ${key}`);
      else if(typeof schema.additionalProperties==="object") validateContract(schema.additionalProperties,v,`${path}.${key}`);
    }
  }
  return true;
}
