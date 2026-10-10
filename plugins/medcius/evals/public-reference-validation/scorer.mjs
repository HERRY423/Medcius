// Score all expected outcomes; abstaining must never remove a difficult case.
export function scoreReferenceResults(cases, results) {
  if (!cases.length || cases.length !== results.length) throw new Error("REFERENCE_PAIRING_INVALID");
  const keys = new Set(cases.map(c=>c.case_id));
  const predictions = new Map(results.map(r=>[r.case_id,r]));
  if(keys.size!==cases.length || predictions.size!==results.length || [...keys].some(k=>!predictions.has(k))) throw new Error("REFERENCE_PAIRING_INVALID");
  const errors=[];
  for(const c of cases) {
    if(!["flag","clear","insufficient_data"].includes(c.expected)) throw new Error("REFERENCE_LABEL_INVALID");
    const r=predictions.get(c.case_id);
    if(r.predicted!==c.expected) errors.push({case_id:c.case_id,reason:"LABEL_MISMATCH"});
    if(c.expected==="flag") {
      const fired=r.review?.dimensions?.[c.dimension]?.facts?.map(f=>f.fact_id)??[];
      if(!(c.expected_fact_ids??[]).some(id=>fired.includes(id))) errors.push({case_id:c.case_id,reason:"FACT_MISS"});
    }
  }
  return {n:cases.length,failures:errors.length,errors,pass:errors.length===0,
    unexpected_abstentions:cases.filter(c=>c.expected!=="insufficient_data" && predictions.get(c.case_id).predicted==="insufficient_data").length};
}
