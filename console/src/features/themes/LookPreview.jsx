import { lookStyles, lookWords } from './form.js';

/** A look as a tiny phone screen, for the picker. Decoration only: the look's name and use sit beside it as text. */
export function LookMini({ look }) {
  const styles = lookStyles(look);
  return (
    <span className="p3-mini" style={styles.page} aria-hidden="true">
      <span className="p3-mini-hero" style={styles.hero}>Aa</span>
      {[0, 1].map((row) => (
        <span key={row} className="p3-mini-row">
          <span className="p3-mini-photo" style={styles.photo} />
          <span className="p3-mini-lines">
            <span className="p3-mini-line" style={styles.line} />
            <span className="p3-mini-line p3-mini-line-short" style={styles.line} />
          </span>
        </span>
      ))}
      <span className="p3-mini-button" style={{ background: styles.button.background === 'transparent' ? look.colors?.primary : styles.button.background, borderRadius: styles.button.borderRadius }} />
    </span>
  );
}

/**
 * How shoppers see a look: a sketch of one of the seller's pages in its colours and shapes, with the seller's own words where they
 * set some. The console around it stays Bhava's; nothing here is sent to shoppers.
 */
export function LookPreview({ look, own }) {
  const styles = lookStyles(look);
  const words = lookWords(look, own);
  return (
    <div className="p3-preview" style={styles.page} role="img" aria-label={`A sketch of your page in the ${look.name ?? look.presetName} look`}>
      {words.ticker.length > 0 && <span className="p3-preview-ticker" style={styles.eyebrow}>{words.ticker.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</span>}
      <span className="p3-preview-title" style={styles.title}>Shop the reel</span>
      <div className="p3-preview-card" style={styles.card}>
        <span className="p3-preview-photo" style={styles.photo} />
        <span className="p3-preview-body">
          <span>Brass diya set</span>
          <span style={styles.muted}>₹499</span>
          <span className="p3-preview-button" style={styles.button}>Buy now</span>
        </span>
      </div>
      {words.seal && <span className="p3-preview-seal" style={styles.seal}>{words.seal}</span>}
    </div>
  );
}
