export const meta = {
  name: 'doctor-pilot-audit',
  description: 'Пилотный аудит 10 неврологов СПб с ПроДокторов: накрутка отзывов, OSINT, entity resolution, компетентность',
  phases: [
    { title: 'Профиль', detail: 'скрейп профиля и отзывов' },
    { title: 'Отзывы', detail: 'признаки накрутки' },
    { title: 'OSINT', detail: 'публикации, соцсети, негатив + entity resolution' },
    { title: 'Высказывания', detail: 'проверка на антинаучные заявления' },
    { title: 'Проверка', detail: 'скептик опровергает негативные выводы' },
    { title: 'Синтез', detail: 'итоговый scorecard' },
  ],
}

const cfg = typeof args === 'string' ? JSON.parse(args) : args
const DIR = cfg.dir
const doctors = cfg.doctors

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    fio: { type: 'string' },
    rating: { type: 'number' },
    n_reviews: { type: 'integer' },
    reviews_collected: { type: 'integer' },
    experience_years: { type: 'integer' },
    qualification: { type: 'string', description: 'категория, степень, звания или пусто' },
    clinics: { type: 'array', items: { type: 'string' } },
    education_summary: { type: 'string' },
    certs_current: { type: 'integer' },
    certs_expired: { type: 'integer' },
    publications_claimed: { type: 'integer' },
    anchors: {
      type: 'object',
      description: 'Якоря идентичности для entity resolution',
      properties: {
        full_name: { type: 'string' },
        city: { type: 'string' },
        specialty: { type: 'string' },
        clinics: { type: 'array', items: { type: 'string' } },
        graduation: { type: 'string', description: 'вуз и год выпуска' },
      },
      required: ['full_name', 'city', 'specialty', 'clinics'],
    },
    notes: { type: 'string' },
  },
  required: ['fio', 'rating', 'n_reviews', 'reviews_collected', 'clinics', 'certs_current', 'certs_expired', 'anchors'],
}

const FRAUD_SCHEMA = {
  type: 'object',
  properties: {
    fraud_score: { type: 'number', description: '0 = отзывы выглядят органическими, 1 = сильнейшие признаки накрутки' },
    signals: { type: 'array', items: { type: 'string' }, description: 'конкретные наблюдаемые признаки с примерами' },
    counter_signals: { type: 'array', items: { type: 'string' }, description: 'признаки органичности' },
    sample_size: { type: 'integer' },
    summary: { type: 'string' },
  },
  required: ['fraud_score', 'signals', 'counter_signals', 'sample_size', 'summary'],
}

const OSINT_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fact: { type: 'string' },
          source_url: { type: 'string' },
          category: { type: 'string', enum: ['publication', 'credential', 'social', 'media', 'negative', 'other'] },
          identity_confidence: { type: 'number', description: '0-1: уверенность что это тот же человек' },
          identity_evidence: { type: 'string', description: 'какие якоря совпали' },
          accepted: { type: 'boolean', description: 'true если identity_confidence >= 0.8' },
        },
        required: ['fact', 'source_url', 'category', 'identity_confidence', 'identity_evidence', 'accepted'],
      },
    },
    rejected_count: { type: 'integer', description: 'сколько находок отброшено как вероятные однофамильцы' },
    search_notes: { type: 'string', description: 'что искали, что не удалось проверить (закрытые соцсети и т.п.)' },
  },
  required: ['facts', 'rejected_count', 'search_notes'],
}

const STATEMENTS_SCHEMA = {
  type: 'object',
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'дословная цитата или точный пересказ' },
          source_url: { type: 'string' },
          why_problematic: { type: 'string', description: 'чему из доказательной медицины противоречит' },
          severity: { type: 'string', enum: ['minor', 'moderate', 'serious'] },
        },
        required: ['quote', 'source_url', 'why_problematic', 'severity'],
      },
    },
    positive_signals: { type: 'array', items: { type: 'string' }, description: 'грамотные, доказательные высказывания' },
    checked_sources: { type: 'integer' },
    summary: { type: 'string' },
  },
  required: ['flags', 'positive_signals', 'checked_sources', 'summary'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true = вывод опровергнут или не выдерживает проверки' },
    reasoning: { type: 'string' },
  },
  required: ['refuted', 'reasoning'],
}

const SCORECARD_SCHEMA = {
  type: 'object',
  properties: {
    fio: { type: 'string' },
    rating_verdict: { type: 'string', enum: ['подтверждён', 'скорее подтверждён', 'сомнителен', 'недостаточно данных'] },
    competence_score: { type: 'number', description: '0-10 по объективным сигналам' },
    fraud_score: { type: 'number' },
    red_flags: { type: 'array', items: { type: 'string' } },
    green_flags: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', description: '0-1 уверенность в вердикте с учётом полноты данных' },
    summary: { type: 'string', description: '3-5 предложений итога' },
  },
  required: ['fio', 'rating_verdict', 'competence_score', 'fraud_score', 'red_flags', 'green_flags', 'confidence', 'summary'],
}

const common = (doc) => `Врач: ${doc.name}, невролог, Санкт-Петербург. Профиль: https://prodoctorov.ru${doc.url}
Рабочая папка: ${DIR}/${doc.slug}/ (создай через mkdir -p, если нет).
Если WebFetch/WebSearch недоступны — загрузи их через ToolSearch ("select:WebFetch,WebSearch").
Твой финальный текст — это данные для пайплайна, не сообщение человеку.`

function profilePrompt(doc) {
  return `${common(doc)}
Задача: собрать полный профиль врача с ПроДокторов.
1. Скачай страницу профиля: образование, сертификаты и повышения квалификации (отдельно посчитай действующие и недействительные), места работы с периодами, стаж, категория/степень, публикации, награды, услуги и цены.
2. Скачай отзывы (страница профиля и/или /otzivi/, до 5 страниц, максимум ~100 отзывов). Для каждого: дата, оценка, текст.
3. Всё сырьё сохрани в ${DIR}/${doc.slug}/profile.json (единый JSON: profile + массив reviews). Это обязательно — следующие стадии читают этот файл.
4. Верни структурированную сводку по схеме. В anchors собери якоря идентичности: полное ФИО с отчеством, город, специальность, все клиники, вуз и год выпуска.
Если сайт отдаёт капчу/блок — попробуй ещё раз через 10-15 секунд, зафиксируй проблему в notes.`
}

function fraudPrompt(doc, profile) {
  return `${common(doc)}
Задача: оценить признаки накрутки отзывов. Прочитай ${DIR}/${doc.slug}/profile.json (массив reviews, собрано ${profile.reviews_collected} из ${profile.n_reviews}).
Проверь: всплески отзывов по датам (много в короткий период); шаблонность и лексическую похожесть текстов; долю пятёрок против смешанных оценок; конкретику (реальные детали приёма vs общие фразы); подозрительно рекламный стиль; соответствие объёма отзывов стажу и загрузке врача.
ВАЖНО: ты видишь только публичные тексты, без данных об аккаунтах — это косвенные признаки, формулируй как "признаки", не как факт накрутки. Отмечай и counter_signals (разнообразие дат/стиля, конкретные детали, наличие критики).
Сохрани анализ в ${DIR}/${doc.slug}/fraud.json и верни результат по схеме.`
}

function osintPrompt(doc, anchorsJson, angle, fileName) {
  return `${common(doc)}
Якоря идентичности (из профиля ПроДокторов): ${anchorsJson}
Задача — OSINT-поиск по углу: ${angle}
Правила entity resolution — ДЛЯ КАЖДОЙ находки оцени identity_confidence, что это именно этот врач:
- полное совпадение ФИО с отчеством: базовые 0.5; без отчества: 0.3
- +0.2 совпадение города, +0.15 специальности, +0.25 клиники из якорей, +0.15 вуза/года выпуска, +0.2 взаимная ссылка (источник ссылается на профиль ПроДокторов или наоборот)
- редкое ФИО повышает уверенность, частое (Петрова, Новикова) — понижает
- максимум 1.0; accepted = confidence >= 0.8. Отброшенные считай в rejected_count.
Ищи на русском разными формулировками (ФИО + специальность, ФИО + клиника, ФИО + город). Telegram-каналы читай через t.me/s/<канал>. Если соцсеть закрыта без логина — зафиксируй в search_notes, не выдумывай содержимое.
Сохрани все находки (включая отброшенные, с пометкой) в ${DIR}/${doc.slug}/${fileName} и верни результат по схеме.`
}

function statementsPrompt(doc, factsJson) {
  return `${common(doc)}
Ниже — подтверждённые (identity_confidence >= 0.8) публичные материалы врача: соцсети, интервью, комментарии в СМИ.
${factsJson}
Задача: открой каждый источник (WebFetch), собери реальные высказывания врача и проверь их против доказательной медицины. Ищи: антипрививочные тезисы, продвижение гомеопатии/остеопатии как лечения, отрицание доказательных методов, псевдодиагнозы, опасные советы.
Каждый флаг — только с дословной цитатой и URL. Не флагай упрощения для пациентов, спорные-но-допустимые мнения и вырванное из контекста. Отмечай и позитивные сигналы (грамотные доказательные разборы).
Сохрани в ${DIR}/${doc.slug}/statements.json и верни результат по схеме.`
}

function skepticPrompt(doc, claim) {
  return `${common(doc)}
Ты — скептик-проверяющий. Ранее пайплайн сделал негативный вывод об этом враче:
"${claim}"
Твоя задача — попытаться ОПРОВЕРГНУТЬ этот вывод: перепроверь источники (файлы в ${DIR}/${doc.slug}/ и URL из вывода), поищи альтернативные объяснения (совпадение, однофамилец, вырванный контекст, нормальная практика, устаревшие данные). Это серьёзное обвинение — оно должно выдержать проверку.
refuted=true если вывод не выдерживает проверки ИЛИ у тебя остаются существенные сомнения. refuted=false только если вывод подтверждается конкретными проверяемыми данными.`
}

function synthPrompt(doc, prev) {
  return `${common(doc)}
Задача: итоговый scorecard врача. Все данные пайплайна:
ПРОФИЛЬ: ${JSON.stringify(prev.profile)}
АНАЛИЗ ОТЗЫВОВ: ${JSON.stringify(prev.fraud)}
OSINT (принятые и отброшенные факты): ${JSON.stringify(prev.osint)}
ВЫСКАЗЫВАНИЯ: ${JSON.stringify(prev.statements)}
ПРОВЕРКА НЕГАТИВНЫХ ВЫВОДОВ СКЕПТИКОМ: ${JSON.stringify(prev.verified)}
Дополнительно можешь читать файлы в ${DIR}/${doc.slug}/.
Правила: негативные выводы, которые скептик опроверг (refuted=true), НЕ учитывай в red_flags — упомяни в summary как непотвердившиеся. competence_score строй на объективном: актуальность сертификатов, категория/степень, публикации (подтверждённые OSINT), стаж, качество публичных высказываний. rating_verdict — насколько рейтинг 5.0 бьётся с объективной картиной. Учитывай полноту данных в confidence.
Сохрани в ${DIR}/${doc.slug}/scorecard.json и верни результат по схеме.`
}

const results = await pipeline(
  doctors,
  (d, doc) => agent(profilePrompt(doc), { label: `profile:${doc.slug}`, phase: 'Профиль', schema: PROFILE_SCHEMA }),
  async (profile, doc) => {
    if (!profile) throw new Error('профиль не собран')
    const anchorsJson = JSON.stringify(profile.anchors)
    const [fraud, sci, soc, neg] = await parallel([
      () => agent(fraudPrompt(doc, profile), { label: `fraud:${doc.slug}`, phase: 'Отзывы', schema: FRAUD_SCHEMA }),
      () => agent(osintPrompt(doc, anchorsJson, 'научные публикации (eLibrary, КиберЛенинка, PubMed), диссертации, патенты, выступления на конференциях, преподавание', 'osint_sci.json'), { label: `osint-sci:${doc.slug}`, phase: 'OSINT', schema: OSINT_SCHEMA }),
      () => agent(osintPrompt(doc, anchorsJson, 'соцсети и медиа: VK, Telegram, YouTube, Дзен, Instagram, интервью и комментарии в СМИ, личный сайт, блоги', 'osint_social.json'), { label: `osint-soc:${doc.slug}`, phase: 'OSINT', schema: OSINT_SCHEMA }),
      () => agent(osintPrompt(doc, anchorsJson, 'негатив: жалобы пациентов на других площадках (НаПоправку, Яндекс, 2ГИС, отзовики), судебные дела, дисциплинарные меры, скандалы в СМИ', 'osint_neg.json'), { label: `osint-neg:${doc.slug}`, phase: 'OSINT', schema: OSINT_SCHEMA }),
    ])
    return { profile, fraud, osint: { sci, soc, neg } }
  },
  async (prev, doc) => {
    if (!prev) throw new Error('нет данных')
    const publicFacts = [prev.osint.sci, prev.osint.soc, prev.osint.neg]
      .filter(Boolean)
      .flatMap((o) => o.facts || [])
      .filter((f) => f.accepted && (f.category === 'social' || f.category === 'media'))
    if (!publicFacts.length) {
      return { ...prev, statements: { flags: [], positive_signals: [], checked_sources: 0, summary: 'Подтверждённых публичных высказываний не найдено' } }
    }
    const statements = await agent(statementsPrompt(doc, JSON.stringify(publicFacts)), { label: `statements:${doc.slug}`, phase: 'Высказывания', schema: STATEMENTS_SCHEMA })
    return { ...prev, statements: statements || { flags: [], positive_signals: [], checked_sources: 0, summary: 'анализ не удался' } }
  },
  async (prev, doc) => {
    if (!prev) throw new Error('нет данных')
    const negatives = []
    if (prev.fraud && prev.fraud.fraud_score >= 0.5) {
      negatives.push({ type: 'fraud', claim: `Признаки накрутки отзывов (score ${prev.fraud.fraud_score}): ${prev.fraud.signals.join('; ')}` })
    }
    for (const f of prev.statements.flags || []) {
      negatives.push({ type: 'statement', claim: `Антинаучное высказывание: "${f.quote}" (${f.source_url}) — ${f.why_problematic}` })
    }
    const acceptedNeg = [prev.osint.sci, prev.osint.soc, prev.osint.neg]
      .filter(Boolean)
      .flatMap((o) => o.facts || [])
      .filter((f) => f.accepted && f.category === 'negative')
    for (const f of acceptedNeg) {
      negatives.push({ type: 'osint-negative', claim: `${f.fact} (${f.source_url})` })
    }
    if (!negatives.length) return { ...prev, verified: [] }
    const verified = await parallel(
      negatives.map((n, i) => () =>
        agent(skepticPrompt(doc, n.claim), { label: `verify:${doc.slug}:${i}`, phase: 'Проверка', schema: VERDICT_SCHEMA })
          .then((v) => ({ ...n, refuted: v ? v.refuted : true, reasoning: v ? v.reasoning : 'проверка не удалась — вывод отброшен' }))
      )
    )
    return { ...prev, verified: verified.filter(Boolean) }
  },
  (prev, doc) => {
    if (!prev) throw new Error('нет данных')
    return agent(synthPrompt(doc, prev), { label: `score:${doc.slug}`, phase: 'Синтез', schema: SCORECARD_SCHEMA })
      .then((sc) => (sc ? { slug: doc.slug, url: doc.url, ...sc } : null))
  }
)

const done = results.filter(Boolean)
log(`Готово: ${done.length} из ${doctors.length} врачей прошли полный пайплайн`)
return { scorecards: done, failed: doctors.filter((d) => !done.some((r) => r.slug === d.slug)).map((d) => d.name) }