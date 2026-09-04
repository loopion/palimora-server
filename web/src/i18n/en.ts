export const en = {
  common: {
    nav: {
      home: 'Home',
      pricing: 'Pricing',
      about: 'About',
      cta_signup: 'Create an account',
      cta_open_app: 'Open the workbench',
      lang_toggle: 'FR',
    },
    footer: {
      statement: 'Palimora transcribes your archives, one page at a time.',
      links: {
        pricing: 'Pricing',
        about: 'About',
        privacy: 'Privacy',
        terms: 'Terms',
        contact: 'Get in touch',
      },
      copyright: '© 2026 Palimora',
    },
  },
  home: {
    hero: {
      title: 'Your manuscripts have a story to tell.',
      subtitle:
        'Palimora transcribes handwritten and historical printed documents — difficult hands, multi-page PDFs, historical scripts — so you can read, search, and cite, not just archive.',
      cta_primary: 'Create an account — 100 free pages',
      cta_secondary: 'See how it works',
    },
    workbench: {
      caption: 'A manuscript page, dropped into Palimora, ready to correct.',
    },
    how: {
      title: 'How it works',
      steps: [
        { title: 'Drop it in', body: 'Drag in your PDFs or images — manuscripts, print, multi-page.' },
        { title: 'Transcription', body: 'The Kraken engine recognises the handwriting and produces a first pass.' },
        { title: 'Correct and export', body: 'Review page by page in the workbench, then export as text or ALTO.' },
      ],
    },
    capabilities: {
      title: 'What Palimora recognises',
      items: [
        'Handwriting, from the 18th century to today',
        'Historical print and multiple scripts',
        'Multi-page PDFs, processed page by page',
        'Plain-text or ALTO XML export',
      ],
      stat_slot_label: 'Recognition rate: figures published soon',
    },
    pricing_teaser: {
      title: '1 credit = 1 page',
      body: 'No mandatory subscription. Buy credits when you need them.',
      cta: 'See pricing',
    },
    faq: {
      title: 'Frequently asked questions',
      items: [
        { q: 'What formats are supported?', a: 'PDF, JPEG, PNG, WebP, HEIC/HEIF. Multi-page PDFs are split into pages automatically.' },
        { q: 'What happens to my documents?', a: 'Your files and transcriptions belong to you. Handling is detailed in our privacy policy.' },
        { q: 'How do credits work?', a: '1 credit = 1 transcribed page. 100 pages are free on signup; beyond that, buy a pack or a monthly plan.' },
        { q: 'Can I cancel any time?', a: "Yes. Packs are one-off purchases with no commitment; the Atelier subscription can be cancelled any time from your account." },
      ],
    },
    closing: {
      title: 'Ready to make your archives speak?',
      cta: 'Create a free account',
    },
  },
  pricing: {
    title: 'Simple, per-page pricing.',
    intro: '1 Palimora credit = 1 transcribed page. No page, no cost.',
    loading: 'Loading pricing…',
    error: 'Pricing temporarily unavailable — try again in a moment.',
    credits_explainer: {
      title: 'How credits work',
      body: 'Every transcribed page uses 1 credit, handwritten or printed. AI-assisted correction costs nothing extra. Purchased credits never expire.',
    },
    faq: {
      items: [
        { q: 'How do credits work?', a: '1 credit = 1 transcribed page. 100 pages are free on signup.' },
        { q: 'Can I switch packs?', a: 'Yes, buy a new pack any time; credits stack.' },
        { q: 'Can I cancel any time?', a: 'Yes, the Atelier subscription can be cancelled any time from your account.' },
      ],
    },
    cta: 'Create an account',
  },
  about: {
    title: 'Why Palimora',
    paragraphs: [
      'Palimora came out of a very concrete need: reading handwritten archives without losing months to it.',
      'The name comes from palimpsest — parchment scraped clean to write over, where the erased text always resurfaces underneath. That is what Palimora does: bring the text of your documents back to the surface.',
      'The project is built continuously; feedback from the researchers, archivists, and genealogists using it directly shapes what gets built next.',
    ],
    contact_title: 'A question, or an institutional use case?',
    contact_body: 'Write to me directly:',
  },
  privacy: {
    title: 'Privacy policy',
    intro: 'This policy is being finalised with legal counsel; the structure below reflects what it will cover.',
    sections: [
      { heading: 'Data controller', body: 'Palimora, operated by Emmanuel Pays.' },
      { heading: 'Data collected', body: 'Account (email), uploaded documents and their transcriptions, billing data.' },
      { heading: 'Purposes', body: 'Providing the transcription service, billing, support.' },
      { heading: 'Legal basis', body: 'Performance of the service contract, and legal obligation for billing.' },
      { heading: 'Hosting and processors', body: 'Hosting and payment handled by third-party providers, listed in full in the final policy.' },
      { heading: 'Retention', body: 'For the duration of the contractual relationship, then per applicable legal retention periods.' },
      { heading: 'Your rights', body: 'Access, rectification, erasure, portability — exercised by writing to the contact address.' },
      { heading: 'Cookies', body: 'Strictly necessary cookies only.' },
      { heading: 'Contact', body: 'For any data question, write to the contact address.' },
    ],
  },
  terms: {
    title: 'Terms of service',
    intro: 'These terms are being finalised with legal counsel; the structure below reflects what they will cover.',
    sections: [
      { heading: 'Purpose', body: 'These terms govern use of the Palimora service.' },
      { heading: 'User account', body: 'An account is required to use the service; the user is responsible for keeping their credentials confidential.' },
      { heading: 'Credits and payment', body: '1 credit = 1 transcribed page. Pricing and payment terms are detailed on the Pricing page.' },
      { heading: 'Use of the service', body: 'The user warrants they hold the necessary rights over uploaded documents.' },
      { heading: 'Ownership of documents', body: 'Uploaded documents and their transcriptions remain the property of the user.' },
      { heading: 'Termination', body: 'The user may delete their account at any time; the Atelier subscription can be cancelled from the account.' },
      { heading: 'Liability', body: 'The service is provided as-is; liability limitations will be detailed in the final version.' },
      { heading: 'Governing law', body: 'French law.' },
    ],
  },
} as const
