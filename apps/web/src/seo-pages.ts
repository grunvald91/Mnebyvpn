/**
 * Educational articles adapted for the active site; no service guarantees.
 * The copy models the intended launch offer; this file does not grant access,
 * enable DNS purchases or prove any unverified product capabilities.
 * Never insert account data, secrets, user-specific URLs or invented prices.
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
    heading:'MNEBYVPN: VPN для телефона и компьютера',
    lead:'Разбираем работу VPN, отличие от DNS и проверку сетевого соединения. Фактическая доступность заказа определяется текущим интерфейсом сайта.',
    sections:[
      {heading:'Как работает VPN',paragraphs:[
        'Совместимый VPN-клиент создаёт зашифрованный туннель между устройством и VPN-узлом. Интернет-ресурсы могут видеть адрес выходного узла вместо адреса домашней сети.',
        'Это не означает полной анонимности. Сайты по-прежнему могут узнавать пользователя по входу в аккаунт, файлам cookie и другим признакам.'
      ]},
      {heading:'Как подключиться через MNEBYVPN',paragraphs:[
        'На главной странице можно ознакомиться с предложениями. Если доступ уже активирован, используйте полученную инструкцию. Наличие карточки тарифа не гарантирует, что его сейчас можно оплатить.',
        'Не каждый сайт или приложение обязательно заработает: влияют оператор, качество соединения, настройки устройства и ограничения сторонней платформы.'
      ]},
      {heading:'VPN и Smart DNS — разные технологии',paragraphs:[
        'VPN передаёт сетевой трафик через туннель в пределах выбранной конфигурации. DNS преобразует имена сайтов в сетевые адреса; изменение DNS само по себе не защищает весь интернет-трафик.',
        'На главной странице обозначены VPN, Smart DNS и совместный вариант. Наличие вкладки не подтверждает возможность покупки или одновременную работу сервисов.'
      ]}
    ]
  },
  {
    path:'/smart-dns',
    title:'MNEBYDNS — Smart DNS для Android и других устройств | MNEBYVPN',
    description:'MNEBYDNS — Smart DNS для выбранных интернет-сервисов: особенности, настройка, отличия от VPN и совместное использование с MNEBYVPN.',
    heading:'MNEBYDNS: Smart DNS для доступа к интернет-сервисам',
    lead:'MNEBYDNS и MNEBYVPN — два варианта подключения для разных задач. Разберём преимущества DNS, особенности VPN и их совместного использования.',
    sections:[
      {heading:'Что делает DNS',paragraphs:[
        'DNS помогает устройству найти IP-адрес по имени сайта. В Android функция Private DNS может защищать DNS-запросы при поддержке DNS-over-TLS.',
        'Даже зашифрованный DNS не равен VPN: браузер и приложения обычно передают основной трафик отдельно от DNS-запросов.'
      ]},
      {heading:'Почему Smart DNS не заменяет VPN',paragraphs:[
        'Некоторые реализации Smart DNS используют специальные сетевые маршруты или проксирование для отдельных ресурсов. Их возможности зависят от конкретной архитектуры и сервиса.',
        'Смена DNS-сервера сама по себе не скрывает исходный IP-адрес пользователя от сайта и не гарантирует доступ к ресурсам с географическими ограничениями.'
      ]},
      {heading:'MNEBYDNS и MNEBYVPN вместе',paragraphs:[
        'В зависимости от реализации Smart DNS может применять выборочную маршрутизацию; VPN направляет трафик через заданный туннель. Их совместная работа зависит от настроек клиента.',
        'На главной странице можно проверить актуальный статус вариантов доступа. Публичное оформление Smart DNS и комбинированного тарифа в текущем интерфейсе отключено.'
      ]}
    ]
  },

  {
    path:'/vpn-android',
    title:'Как подключить VPN на Android — MNEBYVPN через INCY',
    description:'Пошаговая настройка MNEBYVPN на Android: выбор VPN-тарифа, установка клиента INCY, импорт подписки и проверка соединения.',
    heading:'Как подключить MNEBYVPN на Android',
    lead:'Текущий сайт указывает INCY как клиент Android. Эта инструкция предназначена для пользователей, уже получивших персональную VPN-подписку.',
    sections:[
      {heading:'Шаг 1. Подготовьте подписку',paragraphs:[
        'Если VPN-подписка уже активирована, откройте предоставленную инструкцию и используйте только выданные параметры доступа.',
        'Персональная ссылка подписки — это ключ доступа. Не публикуйте её, не пересылайте в открытые чаты и не добавляйте на сайты проверки URL.'
      ]},
      {heading:'Шаг 2. Импортируйте подписку в INCY',paragraphs:[
        'Установите приложение INCY для Android по ссылке из инструкции в личном кабинете. Нажмите кнопку импорта подписки и подтвердите открытие в приложении.',
        'Если автоматический переход не сработал, скопируйте персональную ссылку и используйте импорт из URL в INCY. Не вводите адрес сервера и пароль наугад.'
      ]},
      {heading:'Шаг 3. Проверьте работу',paragraphs:[
        'Включите подключение в INCY и подтвердите системный запрос Android на создание VPN. Затем проверьте открытие обычного сайта и необходимого приложения.',
        'Если связь не устанавливается, обновите подписку в клиенте, проверьте мобильный интернет или Wi-Fi и обратитесь в поддержку MNEBYVPN. Возможности конкретного сервиса зависят и от его собственных правил.'
      ]}
    ]
  },
  {
    path:'/vpn-iphone',
    title:'Как подключить VPN на iPhone — MNEBYVPN через Karing',
    description:'Инструкция по VPN на iPhone: получить подписку MNEBYVPN, импортировать её в Karing и проверить соединение.',
    heading:'Как подключить MNEBYVPN на iPhone',
    lead:'Текущий сайт указывает Karing как клиент iPhone. Импорт подписки возможен при наличии действующего доступа и выданной персональной ссылки.',
    sections:[
      {heading:'Получите доступ в личном кабинете',paragraphs:[
        'Если ваш VPN-доступ уже активирован, откройте выданную инструкцию и персональную ссылку подписки. Наличие описания тарифа не означает готовность оплаты.',
        'Сохраните персональную ссылку только в доверенном месте: тот, у кого есть эта ссылка, потенциально может использовать параметры вашего подключения.'
      ]},
      {heading:'Импортируйте VPN в Karing',paragraphs:[
        'Установите Karing для iOS из App Store по ссылке на странице подключения. Нажмите импорт в Karing либо вставьте ссылку через функцию добавления подписки из URL.',
        'Подтвердите системное разрешение iOS на создание VPN-конфигурации. Без такого разрешения клиент не сможет включить VPN-туннель.'
      ]},
      {heading:'Проверьте результат',paragraphs:[
        'После подключения проверьте, что VPN отображается активным в настройках устройства. Затем откройте нужный сайт или приложение и оцените работу нужных функций.',
        'Отдельные действия, например голосовые запросы в ИИ, могут иметь ограничения аккаунта или страны, которые VPN не отменяет.'
      ]}
    ]
  },
  {
    path:'/private-dns-android',
    title:'Private DNS на Android — настройка MNEBYDNS и отличие от VPN',
    description:'Как настроить Private DNS на Android: адрес DNS-over-TLS, проверка подключения, совместимость с VPN и ограничения Smart DNS.',
    heading:'Private DNS на Android: настройка MNEBYDNS',
    lead:'Android Private DNS позволяет использовать DNS-over-TLS с совместимым DNS-сервером. MNEBYDNS предназначен для DNS-сценариев; он не заменяет защищённый VPN-туннель.',
    sections:[
      {heading:'Где включается Private DNS',paragraphs:[
        'На поддерживаемых устройствах Android откройте настройки сети и найдите раздел «Частный DNS» (Private DNS). Названия пунктов отличаются у производителей.',
        'Выберите режим указания имени DNS-провайдера, а не автоматический режим. Для DNS-over-TLS обычно требуется именно доменное имя сервера, а не произвольный IP-адрес.'
      ]},
      {heading:'Как использовать параметры MNEBYDNS',paragraphs:[
        'Если вам выдано активное персональное имя DNS-хоста, введите его без https://, пробелов и пути URL, затем сохраните настройки. Не используйте пример вместо реального адреса.',
        'Если устройство сообщает об ошибке соединения, проверьте точность имени и доступность сети. Не заменяйте подтверждённый адрес случайным DNS-сервером из интернета.'
      ]},
      {heading:'Чем режим отличается от VPN',paragraphs:[
        'Private DNS шифрует DNS-запросы при использовании DNS-over-TLS, но не шифрует весь остальной трафик приложений и не скрывает автоматически исходный IP от посещаемого сайта.',
        'При одновременном использовании MNEBYDNS и VPN поведение DNS зависит от клиента и настроек маршрутизации. Проверяйте результат в активной конфигурации.'
      ]}
    ]
  },
  {
    path:'/youtube',
    title:'YouTube не загружается: проверка сети, VPN и DNS | MNEBYVPN',
    description:'VPN и MNEBYDNS для YouTube: подключение на телефоне и компьютере, проверка ограничений сети и причин ошибок воспроизведения.',
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
        'Наличие VPN-подключения не гарантирует воспроизведение YouTube в конкретной сети; отдельно проверяйте загрузку страницы, видео и вход в аккаунт.'
      ]},
      {heading:'А как насчёт MNEBYDNS',paragraphs:[
        'MNEBYDNS предназначен для выборочных сетевых сценариев. При проблемах с YouTube сравните воспроизведение в браузере и приложении, затем проверьте результат выбранного режима подключения.'
      ]}
    ]
  },
  {
    path:'/instagram',
    title:'Instagram: сетевые ошибки, VPN и Smart DNS | MNEBYVPN',
    description:'VPN и Smart DNS для Instagram: как проверить подключение, отличить сетевые ошибки от проблем приложения и аккаунта.',
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
      {heading:'Smart DNS и Instagram',paragraphs:[
        'MNEBYDNS — отдельный режим для выбранных сервисов. Он не заменяет VPN и не устраняет ограничения, зависящие от аккаунта Instagram.'
      ]}
    ]
  },
  {
    path:'/telegram',
    title:'Telegram: диагностика подключения и DNS | MNEBYVPN',
    description:'VPN для Telegram: сообщения, звонки и медиа, диагностика подключения, когда полезен VPN и чем отличается MNEBYDNS.',
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
        'DNS отвечает за получение адресов узлов, а полноценный VPN — за маршрутизацию трафика через туннель. На главной странице показаны варианты доступа; их оформление зависит от текущего состояния интерфейса.'
      ]}
    ]
  },
  {
    path:'/google-gemini',
    title:'Google Gemini: сеть, аккаунт и DNS | MNEBYVPN',
    description:'VPN и MNEBYDNS для Google Gemini: доступность сайта и приложения, регион аккаунта, голосовые функции и ограничения сервисов.',
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
        'Изменение DNS не меняет правила Google Gemini, регион аккаунта и права на отдельные функции. Настройка DNS не гарантирует работу голосовых и системных функций Gemini.'
      ]}
    ]
  },
  {
    path:'/ai-services',
    title:'ИИ-сервисы: сеть, аккаунт и ограничения | MNEBYVPN',
    description:'VPN и Smart DNS для ChatGPT, Claude, Google Gemini и других ИИ-сервисов: сеть, регион аккаунта, авторизация и ограничения доступа.',
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
        'MNEBYVPN и MNEBYDNS используют разные сетевые механизмы. VPN передаёт выбранный трафик через туннель, DNS решает задачи именования и может быть дополнен маршрутизацией. Возможность использования конкретного ИИ-сервиса определяется также требованиями его платформы.',
        'Перед использованием стороннего сервиса следует учитывать его правила и применимые требования законодательства.'
      ]}
    ]
  }
];

const sourceLinks:Readonly<Record<string,readonly [string,string][]>> = {
  "/vpn": [
    [
      "Apple: безопасность VPN",
      "https://support.apple.com/en-ie/guide/security/sec802e8ab55/web"
    ]
  ],
  "/smart-dns": [
    [
      "RFC 7858: DNS-over-TLS",
      "https://www.rfc-editor.org/rfc/rfc7858"
    ],
    [
      "Google: Private DNS",
      "https://developers.google.com/speed/public-dns/docs/using/"
    ]
  ],
  "/vpn-android": [
    [
      "Android: настройка сетевых подключений",
      "https://developer.android.com/privacy-and-security/risks/bad-dns"
    ]
  ],
  "/vpn-iphone": [
    [
      "Apple: безопасность VPN",
      "https://support.apple.com/en-ie/guide/security/sec802e8ab55/web"
    ]
  ],
  "/private-dns-android": [
    [
      "Google: Private DNS на Android",
      "https://developers.google.com/speed/public-dns/docs/using/"
    ],
    [
      "RFC 7858: DNS-over-TLS",
      "https://www.rfc-editor.org/rfc/rfc7858"
    ]
  ],
  "/youtube": [
    [
      "YouTube: справочный центр",
      "https://support.google.com/youtube/"
    ]
  ],
  "/instagram": [
    [
      "Instagram: справка",
      "https://help.instagram.com/"
    ]
  ],
  "/telegram": [
    [
      "Telegram: FAQ",
      "https://telegram.org/faq"
    ]
  ],
  "/google-gemini": [
    [
      "Google: доступность Gemini",
      "https://support.google.com/gemini/answer/14579026"
    ]
  ],
  "/ai-services": [
    [
      "OpenAI: поддерживаемые страны",
      "https://help.openai.com/en/articles/7947663-chatgpt-supported-countries"
    ],
    [
      "Anthropic: поддерживаемые регионы",
      "https://www.anthropic.com/legal/supported-regions"
    ],
    [
      "Google: доступность Gemini",
      "https://support.google.com/gemini/answer/14579026"
    ]
  ]
};
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
    '@context':'https://schema.org',
    '@graph':[
      {
        '@type':'WebPage','name':page.title,'description':page.description,
        'inLanguage':'ru','url':absolute,
        'isPartOf':{'@type':'WebSite','name':'MNEBYVPN','url':origin+'/'},
      },
      {
        '@type':'BreadcrumbList','itemListElement':[
          {'@type':'ListItem','position':1,'name':'MNEBYVPN','item':origin+'/'},
          {'@type':'ListItem','position':2,'name':page.heading,'item':absolute},
        ],
      },
    ],
  }).replace(/</g,'\\u003c');
  const content=page.sections.map(section=>`
    <section class="seo-section"><h2>${esc(section.heading)}</h2>
      ${section.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}
      ${section.bullets?.length?`<ul>${section.bullets.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}
    </section>`).join('');
  const links=other.map(x=>`<li><a href="${esc(x.path)}">${esc(x.heading)}</a></li>`).join('');
  const references=(sourceLinks[path]??[]).map(([title,url])=>`<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a></li>`).join('');
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
<header class="header"><div class="shell header-inner"><a class="brand" href="/" aria-label="MNEBYVPN — главная"><img class="brand-avatar" src="/brand-avatar.webp" alt="" width="34" height="34"><span class="brand-text">MNEBY<span>VPN</span></span></a><a class="button button-small button-outline" href="/">На главную</a></div></header>
<main class="shell seo-main">
<nav class="seo-breadcrumb" aria-label="Навигация"><a href="/">MNEBYVPN</a> / <span>${esc(page.heading)}</span></nav>
<article class="seo-article"><p class="eyebrow">СПРАВКА MNEBYVPN</p><h1>${esc(page.heading)}</h1><p class="seo-lead">${esc(page.lead)}</p>
${content}
<div class="seo-action"><p>Эта справка не является проверкой работы определённого сервиса через VPN или Smart DNS. Доступность оформления показана на основном сайте.</p><a class="button button-primary" href="/#plans">Проверить доступные варианты</a></div>
<section class="seo-sources"><h2>Первоисточники</h2><ul>${references}</ul></section>
</article>
<aside class="seo-related"><h2>Другие материалы</h2><ul>${links}</ul></aside>
</main>
<footer class="footer"><div class="shell footer-inner"><a href="/">MNEBYVPN</a><div class="footer-links"><a href="/terms">Условия</a><a href="/privacy">Обработка данных</a><a href="/#contact-support">Поддержка</a></div></div></footer>
</body></html>`;
}
