// Offset-preserving implementation of the pinned BertNormalizer +
// BertPreTokenizer + WordPiece contract. Other tokenizers fail closed.
export function createBertTokenizer(spec) {
  const n = spec?.normalizer, model = spec?.model, vocab = model?.vocab;
  if (n?.type !== 'BertNormalizer' || n.clean_text !== true || n.handle_chinese_chars !== true
    || n.lowercase !== false || n.strip_accents != null || spec?.pre_tokenizer?.type !== 'BertPreTokenizer'
    || model?.type !== 'WordPiece' || model.continuing_subword_prefix !== '##'
    || !vocab || ['[CLS]', '[SEP]', '[UNK]'].some(k => !Number.isInteger(vocab[k]))) throw new Error('LOCAL_NER_TOKENIZER_UNSUPPORTED');
  return Object.freeze({
    cls: vocab['[CLS]'], sep: vocab['[SEP]'],
    encode(input) {
      const protectedText = input.replace(/\[(?:ID:[A-Za-z0-9_-]+:(?:[a-f0-9]{32}|REDACTED)|PSN:[a-f0-9]{8,64}|REDACTED:[A-Za-z0-9_]+)\]/g, m => ' '.repeat(m.length));
      const words = []; let word = [], offset = 0;
      const flush = () => { if (word.length) words.push(word); word = []; };
      for (const c of protectedText) {
        const entry = { c, start: offset, end: offset + c.length }; offset += c.length;
        if (/\s/u.test(c)) { flush(); continue; }
        if (/\p{C}/u.test(c) || c === '\ufffd') continue;
        if (/\p{Script=Han}|\p{P}/u.test(c) || /^[!-/:-@[-`{-~]$/.test(c)) { flush(); words.push([entry]); }
        else word.push(entry);
      }
      flush();
      const tokens = [];
      for (const w of words) {
        const unknown = { id: vocab['[UNK]'], start: w[0].start, end: w.at(-1).end };
        if (w.length > model.max_input_chars_per_word) { tokens.push(unknown); continue; }
        const pieces = []; let i = 0;
        while (i < w.length) {
          let j = w.length, id;
          while (j > i) {
            const str = (i ? '##' : '') + w.slice(i,j).map(x => x.c).join('');
            if (Object.hasOwn(vocab, str)) { id = vocab[str]; break; }
            j--;
          }
          if (id == null) { pieces.length = 0; pieces.push(unknown); break; }
          pieces.push({ id, start: w[i].start, end: w[j-1].end }); i = j;
        }
        tokens.push(...pieces);
      }
      return tokens;
    },
  });
}
