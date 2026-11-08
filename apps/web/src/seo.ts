/**
 * Search-readable public informational pages.
 * Never insert user data or secret links. Product readiness is deliberately explicit:
 * MNEBYDNS and the combined mode are NOT available for purchase.
 */
export type SeoPage = {
  path:string; title:string; description:string; heading:string; lead:string;
  sections:{heading:string; paragraphs:string[]; bullets?:string[]}[];
};
export const seoPages:SeoPage[] = [
  {
    path:'/vpn',
    title:'VPN для телефона и компьютера — подключение и управление | MNEBYVPN',
    description:'Как устроено VPN-подключение MNEBYVPN, что меняется при использовании туннеля и почему доступность отдельных сайтов зависит от сети и сервиса.',
    heading:'VPN для телефона и компьютера: что важно знать',
    lead:'MNEBYVPN — сервис VPN-подключения с управлением доступом в личном кабинете. Объясняем, чем помогает VPN и каких результатов нельзя обещать заранее.',
    sections:[
      {heading:'Как работает VPN',paragraphs:[
        'Совместимый VPN-клиент создаёт зашифрованный туннель между устройством и VPN-узлом. Интернет-ресурсы могут видеть адрес выходного узла вместо адреса домашней сети.',
        'Это не означает полной анонимности. Сайты по-прежнему могут узнавать пользователя по входу в аккаунт, файлам cookie и другим признакам.'
      ]},
      {heading:'Как подключиться через MNEBYVPN',paragraphs:[
        'На главной странице можно проверить доступность подключения, выбрать предложенный VPN-тариф и войти в личный кабинет. После выдачи доступа кабинет показывает параметры установки совместимого клиента.',
        'Не каждый сайт или приложение обязательно заработает: влияют оператор, качество соединения, настройки устройства и ограничения сторонней платформы.'
      ]},
      {heading:'VPN и Smart DNS — разные технологии',paragraphs:[
        'VPN передаёт сетевой трафик через туннель в пределах выбранной конфигурации. DNS преобразует имена сайтов в сетевые адреса; изменение DNS само по себе не защищает весь интернет-трафик.',
        'Отдельный продукт MNEBYDNS (Smart DNS) и совместный режим VPN + DNS у нас ещё в разработке и не предлагаются к покупке.'
      ]}
    ]
  },
  {
    path:'/smart-dns',
    title:'Smart DNS для Android: отличие от VPN и статус MNEBYDNS',
    description:'Что делает Smart DNS, чем отличается от VPN и почему MNEBYDNS пока находится в разработке. Без обещаний доступа к любому сервису.',
    heading:'Smart DNS: что это и чем отличается от VPN',
    lead:'Smart DNS и VPN решают разные задачи. В MNEBYVPN разрабатывается отдельный продукт MNEBYDNS, но до завершения проверок он не продаётся.',
    sections:[
      {heading:'Что делает DNS',paragraphs:[
        'DNS помогает устройству найти IP-адрес по имени сайта. В Android функция Private DNS может защищать DNS-запросы при поддержке DNS-over-TLS.',
        'Даже зашифрованный DNS не равен VPN: браузер и приложения обычно передают основной трафик отдельно от DNS-запросов.'
      ]},
      {heading:'Почему Smart DNS не заменяет VPN',paragraphs:[
        'Некоторые реализации Smart DNS используют специальные сетевые маршруты или проксирование для отдельных ресурсов. Их возможности зависят от конкретной архитектуры и сервиса.',
        'Смена DNS-сервера сама по себе не скрывает исходный IP-адрес пользователя от сайта и не гарантирует доступ к ресурсам с географическими ограничениями.'
      ]},
      {heading:'Статус MNEBYDNS',paragraphs:[
        'Мы проверяем работу отдельных режимов и совместимость с VPN. Доступность YouTube, Instagram, Gemini или других сервисов через MNEBYDNS пока не подтверждена.',
        'На сайте сейчас можно ознакомиться с VPN и следить за статусом разработки MNEBYDNS. Отдельных платных тарифов Smart DNS здесь нет.'
      ]}
    ]
  },
  {
    path:'/youtube',
    title:'YouTube не открывается: причины и настройка VPN | MNEBYVPN',
    description:'Что проверять, если YouTube не загружается на телефоне или ПК. Работа сети, DNS, VPN, приложения и ограничения доступа — без гарантий.',
    heading:'YouTube не открывается: что проверить',
    lead:'Неполадки YouTube могут затрагивать браузер, приложение, сеть или отдельные функции воспроизведения. Проверять причину лучше последовательно.',
    sections:[
      {heading:'Проверка на устройстве',paragraphs:[
        'Сначала сравните работу YouTube в браузере и приложении. Убедитесь, что подключение к интернету есть, приложение обновлено, а время устройства выставлено корректно.'
      ],bullets:[
        'Открывается ли главная страница и отдельно — воспроизведение видео?',
        'Воспроизводится ли видео в другой сети, например через мобильный интернет?',
        'Возникает ли ошибка только при входе в аккаунт или во время загрузки ролика?'
      ]},
      {heading:'Может ли помочь VPN',paragraphs:[
        'VPN может изменить путь интернет-трафика и адрес выходного узла. Это иногда влияет на доступность сетевых ресурсов, но не устраняет все проблемы с приложением или аккаунтом.',
        'MNEBYVPN предлагает VPN-подключение; работоспособность YouTube в конкретной сети необходимо проверять на своём устройстве.'
      ]},
      {heading:'А как насчёт MNEBYDNS',paragraphs:[
        'Smart DNS в рамках MNEBYDNS ещё разрабатывается. Подтверждённой совместимости с YouTube пока нет, поэтому не стоит воспринимать DNS как гарантированный способ восстановления воспроизведения.'
      ]}
    ]
  },
  {
    path:'/instagram',
    title:'Instagram не открывается: сеть, VPN и DNS | MNEBYVPN',
    description:'Почему Instagram может не загружаться, как отличить сетевую ошибку от проблемы приложения и как связаны VPN и Smart DNS.',
    heading:'Instagram не открывается: возможные причины',
    lead:'Если Instagram не загружается, важно отличить сетевые ограничения от ошибок приложения и аккаунта. VPN и DNS влияют на соединение по-разному.',
    sections:[
      {heading:'Что проверить сначала',paragraphs:[
        'Сравните работу браузерной версии и приложения. Проверьте подключение к интернету, актуальность приложения и точный текст ошибки.',
        'Если сайт открывается, а вход или загрузка публикаций не работает, проблема не обязательно связана с DNS.'
      ]},
      {heading:'Как связан VPN',paragraphs:[
        'VPN создаёт туннель до выходного сервера и может изменить сетевой маршрут. При этом сервис может учитывать вход в аккаунт, IP выходного узла и собственные правила доступа.',
        'MNEBYVPN не гарантирует работу Instagram в любой сети или на любом аккаунте.'
      ]},
      {heading:'Smart DNS пока в разработке',paragraphs:[
        'MNEBYDNS не предлагается как готовое решение для Instagram. DNS сам по себе не заменяет VPN и не устраняет ограничения, зависящие от аккаунта.'
      ]}
    ]
  },
  {
    path:'/telegram',
    title:'Telegram не подключается: проверка соединения и VPN | MNEBYVPN',
    description:'Что проверить при ошибках Telegram: сеть, приложение, DNS и VPN. Разбор причин без обещания устранить любой сбой.',
    heading:'Telegram не подключается: диагностика',
    lead:'Ошибки Telegram могут проявляться при входе, отправке сообщений или загрузке медиа. Причины у этих ситуаций могут различаться.',
    sections:[
      {heading:'Проверьте характер сбоя',paragraphs:[
        'Сравните текстовые сообщения и загрузку медиа. Проверьте, возникает ли ошибка в Wi-Fi и мобильной сети одинаково, и нет ли проблемы только на одном устройстве.'
      ],bullets:[
        'Есть ли связь с другими интернет-сервисами?',
        'Открывается ли Telegram в другой сети?',
        'Проблема возникает с сообщениями, звонками или только с видео и файлами?'
      ]},
      {heading:'Когда полезно проверить VPN',paragraphs:[
        'Подключение через VPN меняет сетевой маршрут до сервиса. Если проблема зависит от сети, сравнение без VPN и с VPN может помочь локализовать её.',
        'MNEBYVPN не может гарантировать работу всех функций Telegram при любых ограничениях или технических сбоях.'
      ]},
      {heading:'Чем отличается Smart DNS',paragraphs:[
        'DNS отвечает за получение адресов узлов, а полноценный VPN — за маршрутизацию трафика через туннель. MNEBYDNS пока тестируется и не является доступной платной опцией.'
      ]}
    ]
  },
  {
    path:'/google-gemini',
    title:'Google Gemini недоступен: регион, аккаунт и VPN | MNEBYVPN',
    description:'Что проверить при ошибке Google Gemini: доступность сервиса в регионе, аккаунт, приложение, сеть и ограничения VPN или DNS.',
    heading:'Google Gemini недоступен: как найти причину',
    lead:'У Google Gemini доступность функций может зависеть не только от сети, но и от региона, аккаунта, приложения и правил Google.',
    sections:[
      {heading:'Сайт и приложение — не одно и то же',paragraphs:[
        'Если страница Gemini открывается, это ещё не подтверждает работу отправки запросов, голосового режима или системной интеграции Android.',
        'Полезно отдельно проверить авторизацию, текстовый запрос, голосовой ввод и наличие сообщения об ограничении функции.'
      ]},
      {heading:'Почему VPN может быть недостаточно',paragraphs:[
        'VPN способен изменить сетевой маршрут и видимый сайту адрес выхода. Но он не обязательно меняет регион аккаунта, страну платёжного профиля или право пользоваться конкретной функцией.',
        'Поэтому MNEBYVPN не обещает, что Google Gemini заработает на любом устройстве после подключения VPN.'
      ]},
      {heading:'Что с MNEBYDNS',paragraphs:[
        'Мы исследуем сетевые сценарии для MNEBYDNS, но работу Gemini через наш Smart DNS пока не подтверждаем. Продукт остаётся в разработке и не продаётся.'
      ]}
    ]
  },
  {
    path:'/ai-services',
    title:'ChatGPT, Claude, Gemini и другие ИИ: доступность и VPN | MNEBYVPN',
    description:'Сравнение сетевых и аккаунтных ограничений для ChatGPT, Claude, Google Gemini и других ИИ-сервисов. Что может и чего не может VPN.',
    heading:'ИИ-сервисы: почему доступность различается',
    lead:'ChatGPT, Claude, Google Gemini и другие ИИ-инструменты могут предъявлять разные требования к регионам, аккаунтам и сетевым соединениям.',
    sections:[
      {heading:'Какие причины встречаются',paragraphs:[
        'Если сервис не открывается, сначала важно определить характер ошибки: недоступность страницы, отказ во входе, отказ отдельной функции или временный сбой платформы.',
        'Не следует считать любое сообщение об ошибке признаком блокировки на уровне интернет-провайдера.'
      ]},
      {heading:'Что может изменить VPN',paragraphs:[
        'VPN обеспечивает сетевой туннель и может изменить адрес выходного узла. Он не отменяет условия использования стороннего ИИ-сервиса и не гарантирует доступность платных, голосовых или регионально ограниченных функций.'
      ]},
      {heading:'VPN и MNEBYDNS',paragraphs:[
        'MNEBYVPN развивает VPN-подключение. MNEBYDNS — отдельный Smart DNS в разработке. Никаких подтверждённых обещаний работы всех ИИ-платформ через Smart DNS пока нет.',
        'Перед использованием стороннего сервиса следует учитывать его правила и применимые требования законодательства.'
      ]}
    ]
  }
];

const escapeHtml=(value:string):string=>value.replace(/[&<>"']/g,ch=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch] as string));
const esc=escapeHtml;

export function seoPaths():string[]{return seoPages.map(p=>p.path);}
export function renderSeoPage(path:string,origin:string):string|null{
  const page=seoPages.find(p=>p.path===path);
  if(!page)return null;
  const absolute=origin+page.path;
  const other=seoPages.filter(p=>p.path!==path);
  const jsonLd=JSON.stringify({
    '@context':'https://schema.org','@type':'WebPage',
    'name':page.title,'description':page.description,'inLanguage':'ru',
    'url':absolute,'isPartOf':{'@type':'WebSite','name':'MNEBYVPN','url':origin+'/'}
  }).replace(/</g,'\\u003c');
  const content=page.sections.map(section=>`
    <section class="seo-section"><h2>${esc(section.heading)}</h2>
      ${section.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}
      ${section.bullets?.length?`<ul>${section.bullets.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}
    </section>`).join('');
  const links=other.map(x=>`<li><a href="${esc(x.path)}">${esc(x.heading)}</a></li>`).join('');
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#080c20"><meta name="robots" content="index,follow">
<meta name="description" content="${esc(page.description)}">
<title>${esc(page.title)}</title>
<link rel="canonical" href="${esc(absolute)}">
<meta property="og:type" content="article"><meta property="og:site_name" content="MNEBYVPN">
<meta property="og:locale" content="ru_RU"><meta property="og:url" content="${esc(absolute)}">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<link rel="icon" type="image/webp" href="/brand-avatar.webp">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/neo.css">
<link rel="stylesheet" href="/seo.css">
<script type="application/ld+json">${jsonLd}</script>
</head><body>
<header class="header"><div class="shell header-inner"><a class="brand" href="/" aria-label="MNEBYVPN — главная"><img class="brand-avatar" src="/brand-avatar.webp" alt="" width="34" height="34"><span class="brand-text">MNEBY<span>VPN</span></span></a><a class="button button-small button-outline" href="/#plans">VPN и тарифы</a></div></header>
<main class="shell seo-main">
<nav class="seo-breadcrumb" aria-label="Навигация"><a href="/">MNEBYVPN</a> / <span>${esc(page.heading)}</span></nav>
<article class="seo-article"><p class="eyebrow">СПРАВКА MNEBYVPN</p><h1>${esc(page.heading)}</h1><p class="seo-lead">${esc(page.lead)}</p>
${content}
<div class="seo-action"><p>Узнайте о VPN-подключении и текущем состоянии MNEBYDNS на основном сайте.</p><a class="button button-primary" href="/#plans">VPN на MNEBYVPN</a></div>
</article>
<aside class="seo-related"><h2>Другие материалы</h2><ul>${links}</ul></aside>
</main>
<footer class="footer"><div class="shell footer-inner"><a href="/">MNEBYVPN</a><div class="footer-links"><a href="/terms">Условия</a><a href="/privacy">Обработка данных</a><a href="/#contact-support">Поддержка</a></div></div></footer>
</body></html>`;
}
export function renderRobots(origin:string):string{
  return ['User-agent: *','Disallow: /api/','Disallow: /auth/',
    'Disallow: /sub/','Disallow: /install/','Disallow: /webhooks/',
    'Disallow: /healthz','Disallow: /readyz',
    'Sitemap: '+origin+'/sitemap.xml',''].join('\n');
}
export function renderSitemap(origin:string):string{
  const paths=['/','/terms','/privacy',...seoPaths()];
  const urls=paths.map(path=>`  <url><loc>${esc(origin+path)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
