// Execution-only rewrite of the pinned BERT graph. No weight, vocabulary,
// precision, label, attention window or decision-threshold changes.
// Ordinary dynamic-quantized batching is NOT equivalent: activation extrema
// would cross text boundaries. Quantize each example independently instead.
import proto from 'onnx-proto';
import { createHash } from 'node:crypto';
const { onnx } = proto;
const SOURCE_SHA256 = '7f8e1a4dac9c65d880b41c8ebedda02f074536f5ab249bdae66cfe41ae709dee';
export const BATCH_GRAPH_VERSION = 'independent-quantization-v1';
const fail = () => { throw new Error('LOCAL_NER_GRAPH_UNSUPPORTED'); };
const tensor = (name, dims, dataType, rawData) => ({ name, dims, dataType, rawData });
const f32 = values => Buffer.from(new Float32Array(values).buffer);
const i64 = values => Buffer.from(BigInt64Array.from(values, BigInt).buffer);
const node = (opType, input, output, attrs = {}, domain = '') => ({ opType, input, output, domain,
  attribute: Object.entries(attrs).map(([name,value]) => Array.isArray(value)
    ? { name, type:7, ints:value } : { name, type:2, i:value }) });

export function buildIndependentBatchGraph(bytes) {
  // This is a narrow compiler, not a permissive optimizer for arbitrary models.
  if (createHash('sha256').update(bytes).digest('hex') !== SOURCE_SHA256) fail();
  const model = onnx.ModelProto.decode(bytes), graph = model.graph, original = [...graph.node];
  const tensors = new Map(graph.initializer.map(t => [t.name,t]));
  const byOutput = new Map(original.flatMap(n => n.output.map(o => [o,n]))), consumers = new Map();
  for (const n of original) for (const name of n.input) {
    if (!consumers.has(name)) consumers.set(name,[]); consumers.get(name).push(n);
  }
  const add = t => { if (tensors.has(t.name)) fail(); tensors.set(t.name,t); return t.name; };
  add(tensor('ib_zero',[],1,f32([0]))); add(tensor('ib_one',[],1,f32([1])));
  add(tensor('ib_255',[],1,f32([255]))); add(tensor('ib_zero_u8',[],2,Buffer.from([0])));
  add(tensor('ib_vector',[1],7,i64([-1])));
  const removed = new Set(), replacements = new Map();
  const sole = name => { const list=consumers.get(name); if (list?.length!==1) fail(); return list[0]; };
  const quantizers = original.filter(n=>n.opType==='DynamicQuantizeLinear');
  const matrices = original.filter(n=>n.opType==='MatMulInteger');
  if (quantizers.length!==49 || matrices.length!==73) fail();
  for (let i=0;i<quantizers.length;i++) {
    const n=quantizers[i], p=`ib_quant_${i}_`, steps=[];
    const op=(kind,ins,out,attrs) => { const name=p+out; steps.push(node(kind,ins,[name],attrs)); return name; };
    // Padded positions are excluded from BOTH extrema. Each valid token sees
    // exactly the same range/scale/zero point as an independent inference.
    const valid=op('Where',['ib_mask',n.input[0],'ib_zero'],'valid');
    let lo=op('ReduceMin',[valid],'lo',{axes:[1,2],keepdims:1});
    let hi=op('ReduceMax',[valid],'hi',{axes:[1,2],keepdims:1});
    lo=op('Min',[lo,'ib_zero'],'min'); hi=op('Max',[hi,'ib_zero'],'max');
    const range=op('Sub',[hi,lo],'range'), equal=op('Equal',[hi,lo],'equal');
    const scale=op('Div',[range,'ib_255'],'scale0');
    steps.push(node('Where',[equal,'ib_one',scale],[n.output[1]]));
    let zp=op('Div',[lo,n.output[1]],'minus_zp'); zp=op('Sub',['ib_zero',zp],'zp');
    zp=op('Clip',[zp,'ib_zero','ib_255'],'clipped'); zp=op('Round',[zp],'rounded');
    steps.push(node('Cast',[zp],[n.output[2]],{to:2}));
    const s=op('Reshape',[n.output[1],'ib_vector'],'scales');
    const z=op('Reshape',[n.output[2],'ib_vector'],'zeros');
    steps.push(node('QuantizeLinear',[n.input[0],s,z],[n.output[0]],{axis:0}));
    replacements.set(n,steps); removed.add(n);
  }
  let groups=0, tripleGroups=0, maximumDotBound=0;
  for (const first of matrices) {
    if (removed.has(first)) continue;
    const peers=matrices.filter(n=>n.input[0]===first.input[0]);
    if (![1,3].includes(peers.length)) fail();
    if (peers.length===3) tripleGroups++;
    const rows=peers.map(n=>{
      const cast=sole(n.output[0]), scaled=sole(cast.output[0]), bias=sole(scaled.output[0]);
      const product=byOutput.get(scaled.input.find(x=>x!==cast.output[0]));
      if (cast.opType!=='Cast' || scaled.opType!=='Mul' || bias.opType!=='Add' || product?.opType!=='Mul') fail();
      const bscale=product.input.find(x=>tensors.has(x)), ascale=product.input.find(x=>x!==bscale);
      const biasName=bias.input.find(x=>tensors.has(x));
      if (!bscale || !ascale || !biasName || n.input[2]!==first.input[2]) fail();
      for (const item of [n,cast,scaled,bias,product]) removed.add(item);
      return { n,cast,scaled,bias,product,bscale,ascale,biasName };
    });
    const weights=rows.map(r=>tensors.get(r.n.input[1]));
    const height=Number(weights[0].dims[0]), widths=weights.map(t=>Number(t.dims[1]));
    if (weights.some((w,i)=>w.dataType!==3 || w.dims.length!==2 || Number(w.dims[0])!==height
      || w.rawData.length!==height*widths[i])) fail();
    for (const row of rows) {
      const zp=tensors.get(row.n.input[3]);
      if(!zp || zp.rawData.some(v=>v!==0) || zp.int32Data.some(v=>v!==0)) fail();
    }
    const width=widths.reduce((s,n)=>s+n,0), joined=Buffer.alloc(height*width);
    let start=0;
    weights.forEach((w,i)=>{
      for(let r=0;r<height;r++) joined.set(w.rawData.subarray(r*widths[i],(r+1)*widths[i]),r*width+start);
      start+=widths[i];
    });
    const sums=new Float32Array(width), positive=new Int32Array(width), negative=new Int32Array(width);
    for(let r=0;r<height;r++) for(let c=0;c<width;c++) {
      const v=joined.readInt8(r*width+c); sums[c]+=v;
      if(v>0) positive[c]+=v; else negative[c]-=v;
    }
    // Exactness proof for the float output of the integer GEMM: every raw dot,
    // zero-point correction and centered integer fits exactly in float32.
    // Multiplication by the ORIGINAL per-example scale*weight scale happens
    // only after this exact subtraction, in the original order.
    for(let c=0;c<width;c++) {
      const bound=255*Math.max(positive[c],negative[c]); maximumDotBound=Math.max(maximumDotBound,bound);
      if(bound>=2**24) fail();
    }
    const p=`ib_linear_${groups++}_`;
    const weight=add(tensor(p+'weight',[height,width],3,joined));
    const colsum=add(tensor(p+'sums',[1,1,width],1,Buffer.from(sums.buffer)));
    const concatenate=name=>Buffer.concat(rows.map(r=>{
      const t=tensors.get(r[name]); if(t?.dataType!==1 || t.dims.length!==1) fail();
      const data=t.rawData.length ? t.rawData : f32(t.floatData);
      if(data.length!==Number(t.dims[0])*4) fail(); return data;
    }));
    const bscale=add(tensor(p+'bscale',[width],1,concatenate('bscale')));
    const bias=add(tensor(p+'bias',[width],1,concatenate('biasName')));
    const final=peers.length===1 ? rows[0].bias.output[0] : p+'output';
    const steps=[node('MatMulIntegerToFloat',[first.input[0],weight,'ib_one','ib_one','ib_zero_u8'],[p+'dot'],{},'com.microsoft'),
      node('Cast',[first.input[2]],[p+'zp'],{to:1}),node('Mul',[p+'zp',colsum],[p+'offset']),
      node('Sub',[p+'dot',p+'offset'],[p+'centered']),node('Mul',[rows[0].ascale,bscale],[p+'scale']),
      node('Mul',[p+'centered',p+'scale'],[p+'scaled']),node('Add',[p+'scaled',bias],[final])];
    if(peers.length===3) {
      const split=add(tensor(p+'split',[3],7,i64(widths)));
      steps.push(node('Split',[final,split],rows.map(r=>r.bias.output[0]),{axis:2}));
    }
    replacements.set(first,steps);
  }
  if(groups!==49 || tripleGroups!==12 || maximumDotBound!==7292745) fail();
  const maskAxis=add(tensor('ib_mask_axis',[1],7,i64([2])));
  const output=[node('Unsqueeze',['attention_mask',maskAxis],['ib_mask0']),node('Cast',['ib_mask0'],['ib_mask'],{to:9}),
    node('Cast',['attention_mask'],['ib_mha_mask'],{to:6})];
  let attentionCount=0;
  for (const n of original) {
    if(replacements.has(n)) { output.push(...replacements.get(n)); continue; }
    if(removed.has(n)) continue;
    const prefix=/^(\/bert\/encoder\/layer\.\d+\/attention\/self\/)/.exec(n.name)?.[1];
    if(prefix) {
      if(n.name===prefix+'Reshape_3') {
        output.push(node('MultiHeadAttention',[prefix+'query/Add_output_0',prefix+'key/Add_output_0',prefix+'value/Add_output_0','','ib_mha_mask'],
          [...n.output],{num_heads:12},'com.microsoft')); attentionCount++;
      }
      continue;
    }
    // Opset 13 moves these axes from attributes to tensor inputs.
    if(['Unsqueeze','Squeeze','ReduceSum'].includes(n.opType)) {
      const axes=n.attribute.find(a=>a.name==='axes');
      if(axes) { const key=add(tensor(`ib_axes_${output.length}`,[axes.ints.length],7,i64(axes.ints.map(Number))));
        n.input.push(key); n.attribute=n.attribute.filter(a=>a!==axes); }
    }
    output.push(n);
  }
  if(attentionCount!==12) fail();
  graph.node=output; graph.valueInfo=[];
  const used=new Set(output.flatMap(n=>n.input)); graph.initializer=[...tensors.values()].filter(t=>used.has(t.name));
  for(const op of model.opsetImport) if(!op.domain) op.version=13;
  if(!model.opsetImport.some(op=>op.domain==='com.microsoft')) model.opsetImport.push({domain:'com.microsoft',version:1});
  return Buffer.from(onnx.ModelProto.encode(onnx.ModelProto.fromObject(model)).finish());
}
