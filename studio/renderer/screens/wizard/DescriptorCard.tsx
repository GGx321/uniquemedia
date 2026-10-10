import { bodyPhrase, type AvatarBody, type Draft } from "../../../shared/engine";
import { descriptorHead } from "../../lib/body";

// The wizard's «Дескриптор» card. S5.2d (.omc/stage5/design 01–03, corrected by plan r2.1 · N4): before the draft, a preview of what Studio itself
// adds to the descriptor — only the body phrase, at its end, as `bodyPhrase` writes it, live from the «Тело» tab (the build word is the model's, inside
// its text, and is never previewed here). Once the draft exists: the real descriptor, with that phrase marked where every prompt carries it.

function Legend() {
  return (
    <span className="look-legend desc-head-legend">
      <span className="look-legend-sw" aria-hidden="true" />
      тело — из вкладки «Тело»
    </span>
  );
}

export function DescriptorCard({ draft, body }: { draft: Draft | null; body: AvatarBody }) {
  const phrase = bodyPhrase(body);
  const head = (
    <>
      <h2 id="descriptor-title" className="fl">
        Дескриптор
      </h2>
      <span className="muted">уходит в каждый промпт как якорь внешности</span>
    </>
  );

  if (draft === null) {
    return (
      <section className="card descriptor-card" aria-labelledby="descriptor-title">
        <div className="descriptor-head">
          {head}
          <span className="tag tag-o desc-pre-tag">предпросмотр тела</span>
        </div>
        <p className="desc-pre-note">
          Лицо, волосы и телосложение опишет модель после оплаты. Тело Studio допишет сама — одной фразой в конце описания{phrase === undefined ? "." : ":"}
        </p>
        {phrase !== undefined ? (
          <p className="descriptor-text mono" lang="en">
            …; <span className="desc-body">{phrase}</span>.
          </p>
        ) : (
          <p className="look-legend">Поля «Тела» пустые — Studio ничего не допишет. Тогда тело решает модель, и от фото к фото оно будет разным.</p>
        )}
      </section>
    );
  }

  return (
    <section className="card descriptor-card" aria-labelledby="descriptor-title">
      <div className="descriptor-head">
        {head}
        {phrase !== undefined && <Legend />}
      </div>
      {/* Read-only: written once with the draft, the anchor of every later prompt. The body phrase follows «; » as `promptSubject` joins them; the
          closing period is the display's own. */}
      <p className="descriptor-text mono" lang="en">
        {phrase === undefined ? (
          draft.descriptor.text
        ) : (
          <>
            {descriptorHead(draft.descriptor.text)}; <span className="desc-body">{phrase}</span>.
          </>
        )}
      </p>
    </section>
  );
}
