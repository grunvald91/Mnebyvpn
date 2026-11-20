/**
 * Public, server-rendered informational pages. No user identifiers, private URLs,
 * dynamic pricing or universal service guarantees in crawler-visible HTML.
 */
import {SEO_DIAGNOSTICS} from './seo-diagnostics.ts';

export type SeoSection={heading:string;paragraphs:string[];points?:string[]};
export type SeoFaq={question:string;answer:string};
export type SeoPage={
  path:string;label:string;title:string;description:string;headline:string;
  lead:string;sections:SeoSection[];faq:SeoFaq[];
};
export const SEO_PAGES:ReadonlyArray<SeoPage>=[
  {
    path:'/vpn',label:'VPN',title:'VPN для Android и iPhone — подключение и отличия от DNS | MNEBYVPN',
    description:'Как работает VPN, когда он нужен вместо Smart DNS, что проверить при ошибке подключения. Инструкция и варианты доступа MNEBYVPN.',
    headline:'VPN для Android и iPhone: когда нужен полный туннель',
    lead:'VPN создаёт защищённый туннель от устройства до VPN-сервера. Он полезен там, где обычного DNS недостаточно: для приложений, соединений по IP и сетей с ограничениями. MNEBYVPN предлагает VPN как отдельный режим и как часть экосистемы.',
    sections:[
      {heading:'Чем VPN отличается от Smart DNS',paragraphs:[
        'VPN передаёт выбранный клиентом трафик через туннель. Smart DNS обрабатывает доменные запросы и в MNEBYVPN может работать вместе с отдельными серверными маршрутами. Эти технологии решают разные задачи.',
        'Если приложение не подключается по причине сетевой фильтрации, один лишь другой DNS-адрес не всегда поможет. Поэтому в MNEBYVPN доступны оба режима — можно подобрать подходящий для конкретной сети.'
      ]},
      {heading:'Как подключить VPN',paragraphs:[
        'Выберите VPN-тариф или пакет «3 в 1», получите персональную подписку в личном кабинете и добавьте её в совместимый VPN-клиент на устройстве. Подсказки по импорту отображаются при выдаче доступа.',
        'Не передавайте персональную ссылку третьим лицам. После подключения проверьте работу нужного приложения и при необходимости обратитесь в поддержку.'
      ],points:['Android: откройте совместимый клиент и импортируйте персональную подписку.','iPhone: используйте поддерживаемый VPN-клиент и следуйте инструкции в личном кабинете.','Если VPN не соединяется, проверьте сеть, актуальность срока доступа и время устройства.']},
      {heading:'Что делать, если VPN не работает',paragraphs:[
        'Сначала проверьте обычное соединение без VPN, затем попробуйте другую сеть — например, домашний Wi-Fi вместо мобильного интернета. Результат может различаться у операторов и в конкретных регионах.',
        'Не обещаем работу на любой сети и не называем VPN абсолютной анонимностью: соединение и политика приложения требуют отдельных проверок.'
      ]}
    ],
    faq:[
      {question:'Нужно ли выключать Smart DNS при использовании VPN?',answer:'Нет обязательного требования отключать его заранее. Совместимость зависит от ОС, настроек VPN-клиента и DNS-маршрутов; проверяйте конкретную комбинацию.'},
      {question:'VPN и прокси Telegram — одно и то же?',answer:'Нет. Прокси Telegram предназначен для Telegram, а VPN может маршрутизировать трафик других приложений согласно настройкам клиента.'}
    ]
  },
  {
    path:'/smart-dns',label:'Smart DNS',title:'Smart DNS без VPN — настройка на Android и iPhone | MNEBYVPN',
    description:'Что такое Smart DNS, как настроить частный DNS Android и профиль iPhone, чем DNS отличается от VPN и почему доступность сервисов зависит от сети.',
    headline:'Smart DNS без постоянно включённого VPN',
    lead:'Smart DNS помогает организовать доступ к выбранным зарубежным ресурсам без постоянного переключения VPN. На Android используется системная настройка «Частный DNS», на совместимых устройствах Apple — профиль DNS. Для сложных сетевых ограничений предусмотрен отдельный VPN.',
    sections:[
      {heading:'Как работает Smart DNS',paragraphs:[
        'DNS превращает доменное имя в сетевой адрес. В MNEBYVPN персональный DNS — часть системы обработки запросов и маршрутизации выбранных ресурсов. Это не то же самое, что шифрованный VPN-туннель для всего трафика.',
        'Если приложение требует соединения по IP, использует собственный DNS или сеть фильтрует TLS-соединение, одного изменения DNS может оказаться недостаточно. В таких случаях выбирают VPN.'
      ]},
      {heading:'Настройка частного DNS на Android',paragraphs:[
        'Откройте настройки сети Android, найдите «Частный DNS» (Private DNS), выберите режим с именем хоста провайдера и вставьте выданное вам персональное имя DNS. Сохраните настройки и проверьте нужные сайты.',
        'Название раздела зависит от производителя и версии Android. Не вставляйте в общедоступные инструкции свой персональный DNS-адрес — он связан с вашим доступом.'
      ]},
      {heading:'Настройка на iPhone и Mac',paragraphs:[
        'Для совместимых устройств Apple используется персональный DNS-профиль формата .mobileconfig. Получите его из своего кабинета и изучите системное подтверждение установки. Если iOS сообщает об ошибке профиля, обратитесь в поддержку.',
        'Smart DNS не гарантирует работу всех приложений и не скрывает весь интернет-трафик от сети так, как это делает VPN. Для задач, требующих полноценного туннеля, выберите соответствующий режим.'
      ]}
    ],
    faq:[
      {question:'Можно ли пользоваться Smart DNS без отдельного VPN-приложения?',answer:'Да, системная настройка Private DNS на поддерживаемом Android не требует отдельного VPN-приложения. Возможности доступа к конкретным сервисам зависят от маршрутов и сети.'},
      {question:'Почему сайт не открывается даже после смены DNS?',answer:'Проблема может возникать не на этапе DNS, а при соединении, авторизации, проверке региона или работе приложения. В таком случае проверьте VPN-режим и статус сервиса.'}
    ]
  },
  {
    path:'/chatgpt',label:'ChatGPT',title:'ChatGPT не открывается — что проверить и как подключиться | MNEBYVPN',
    description:'Почему не открывается ChatGPT: сеть, DNS, вход в аккаунт и ограничения региона. Как проверить доступ через Smart DNS или VPN MNEBYVPN.',
    headline:'ChatGPT не открывается: проверяем причины по порядку',
    lead:'Если страница ChatGPT не загружается или появляется ошибка соединения, причина не обязательно в самом сервисе. Проблема может быть связана с DNS, сетевым соединением, браузером или требованиями OpenAI к поддерживаемым регионам.',
    sections:[
      {heading:'Сначала определите характер ошибки',paragraphs:[
        'Откройте официальный адрес chatgpt.com. Если браузер сообщает, что адрес не найден, проверьте работу DNS. Если страница загружается, но вход не проходит, проверьте авторизацию и сообщения самого сервиса.',
        'Сведения о сбоях платформы можно проверить на официальной странице status.openai.com. Используйте только собственный аккаунт и учитывайте действующие правила OpenAI.'
      ]},
      {heading:'Когда помогает Smart DNS, а когда VPN',paragraphs:[
        'Для некоторых сценариев достаточно корректного DNS и маршрутов MNEBYVPN. Если соединение блокируется после DNS-разрешения или приложение использует другие сетевые механизмы, может понадобиться VPN.',
        'В MNEBYVPN можно начать с Smart DNS, а при необходимости включить VPN. Такой порядок не отменяет условия использования ChatGPT и региональные требования самого сервиса.'
      ]},
      {heading:'Проверка после подключения',paragraphs:[
        'Сначала откройте главную страницу ChatGPT, затем проверьте вход и отдельный диалог. Если интерфейс работает, но ответы не загружаются, ошибка может касаться другого соединения или сервиса.',
        'При обращении в поддержку укажите устройство, тип сети, экран с ошибкой без персональных данных и использованный режим MNEBYVPN.'
      ]}
    ],
    faq:[
      {question:'Помогает ли смена DNS при любой ошибке ChatGPT?',answer:'Нет. DNS не исправляет ошибки учётной записи, ограничения самого OpenAI или проблемы, возникающие после установления соединения.'},
      {question:'Где проверить, не упал ли сам ChatGPT?',answer:'На официальной странице статуса OpenAI: https://status.openai.com/.'}
    ]
  },
  {
    path:'/claude',label:'Claude и Claude Code',title:'Claude AI и Claude Code не открываются — доступ и диагностика | MNEBYVPN',
    description:'Как проверить доступ к Claude и Claude Code: сеть, DNS, авторизация и различия веб-версии и CLI. Smart DNS и VPN от MNEBYVPN.',
    headline:'Claude AI и Claude Code: что делать при ошибке доступа',
    lead:'Claude работает в браузере, а Claude Code использует собственные сетевые обращения в среде разработки. Если один вариант открывается, а другой нет, причину нужно искать отдельно: требования к аккаунту и сети могут различаться.',
    sections:[
      {heading:'Проверка Claude в браузере',paragraphs:[
        'Сначала откройте официальный сайт claude.ai. Разделите проблемы: недоступен сам адрес, не проходит вход или чат открывается, но запросы не отправляются. Так легче понять, что именно нужно исправить.',
        'Если сайт не отвечает, проверьте подключение в другой сети и актуальные сообщения Anthropic о состоянии сервисов.'
      ]},
      {heading:'Особенности Claude Code',paragraphs:[
        'Терминальный инструмент может выполнять API-запросы и обращаться к дополнительным ресурсам, не совпадающим с теми, которые видит браузер. Поэтому успех обычного входа на claude.ai ещё не доказывает работоспособность CLI.',
        'Проверьте выход в интернет из самой среды выполнения, настройки прокси при их использовании и ошибки авторизации. Не размещайте API-ключи, рабочие токены или логи с секретами в открытых обращениях.'
      ]},
      {heading:'Как использовать MNEBYVPN',paragraphs:[
        'Подключите персональный Smart DNS и проверьте нужный сценарий Claude. Если сетевого маршрута недостаточно, попробуйте VPN и повторите проверку.',
        'Доступ к сетевым адресам не заменяет регистрацию в поддерживаемом регионе и не отменяет правила Anthropic.'
      ]}
    ],
    faq:[
      {question:'Почему Claude открывается в браузере, но Claude Code не работает?',answer:'Это разные клиенты с возможными различиями в адресах, среде выполнения и аутентификации. Проверьте сетевые запросы и авторизацию именно Claude Code.'},
      {question:'Скрывает ли Smart DNS мой API-ключ?',answer:'Нет. DNS не является хранилищем ключей и не заменяет безопасность аккаунта и переменных среды.'}
    ]
  },
  {
    path:'/gemini',label:'Google Gemini',title:'Gemini не открывается или не работает — что проверить | MNEBYVPN',
    description:'Gemini не работает, не открывается сайт или не проходит вход? Пошаговая проверка Google Gemini, DNS, VPN, браузера и региональных ограничений.',
    headline:'Gemini не работает или не открывается: что проверить',
    lead:'Если Google Gemini не загружается, появляется ошибка региона или не проходит вход, начните с определения причины. Доступность сайта, авторизация Google и работа самой модели — разные этапы.',
    sections:[
      {heading:'Почему Gemini может не открываться',paragraphs:[
        'Возможные причины: ошибка DNS, фильтрация соединения, проблемы Google-аккаунта, настройки браузера, сбой сервиса или ограничения доступности продукта в конкретной стране.',
        'Проверьте официальный сайт gemini.google.com и доступность других сайтов Google. Если браузер открывает страницу, но запросы не выполняются, одна лишь смена DNS может не решить проблему.'
      ]},
      {heading:'Как последовательно проверить доступ',paragraphs:[
        'Убедитесь, что интернет работает. Проверьте Gemini на другом соединении, например Wi-Fi вместо мобильной сети. Затем попробуйте Smart DNS MNEBYVPN и отдельно — VPN, если сетевой маршрут требует туннеля.',
        'После подключения откройте Gemini и отправьте обычный тестовый запрос. Если не работает только вход, проверьте учётную запись и официальные требования Google к доступности продукта.'
      ]},
      {heading:'Gemini, Google AI Studio и Antigravity — не одно приложение',paragraphs:[
        'Gemini — пользовательский ИИ-сервис Google. Google AI Studio — среда работы с моделями и API. Google Antigravity — платформа разработки с ИИ-агентами. У каждого могут быть свои экраны входа, сетевые обращения и ограничения.',
        'Для Google Antigravity подготовлена отдельная инструкция. Проверка Gemini в браузере не заменяет проверку остальных продуктов.'
      ]}
    ],
    faq:[
      {question:'Gemini не открывается — достаточно ли изменить DNS?',answer:'Не всегда. Если причина в региональных требованиях Google, аккаунте или фильтрации соединения после DNS, необходима отдельная проверка.'},
      {question:'Могу ли я использовать VPN одновременно с Private DNS?',answer:'Это зависит от настроек устройства и VPN-клиента. Проверьте выбранный режим и работу Gemini после подключения.'}
    ]
  },
  {
    path:'/google-antigravity',label:'Google Antigravity',title:'Google Antigravity не работает — доступ и диагностика | MNEBYVPN',
    description:'Что делать, если Google Antigravity не открывается, не авторизуется или теряет соединение с ИИ-агентом. Различия сети, DNS и VPN.',
    headline:'Google Antigravity не работает: диагностика соединения',
    lead:'Google Antigravity — платформа разработки с ИИ-агентами. Если программа не проходит вход, не загружает модели или не выполняет задачи, нужно проверять не только сайт, но и сетевую среду, в которой запущен инструмент.',
    sections:[
      {heading:'Что проверить в первую очередь',paragraphs:[
        'Проверьте обычный доступ к интернету, обновления приложения и вход в Google-аккаунт. Зафиксируйте точный момент ошибки: на экране авторизации, при выборе модели или уже во время работы агента.',
        'Если подключение работает в браузере, но Antigravity сообщает об ошибке, возможны дополнительные сетевые обращения самого приложения. Отдельно проверьте доступность Google AI Studio и других сервисов Google, но не считайте их работу доказательством исправности Antigravity.'
      ]},
      {heading:'Smart DNS и VPN для Antigravity',paragraphs:[
        'MNEBYVPN позволяет попробовать персональный Smart DNS и при необходимости использовать VPN. Выбор зависит от того, блокируется ли только определение адреса либо дальнейшее соединение.',
        'Проверяйте именно вход в Antigravity, загрузку моделей и выполнение тестового задания. Сеть, аккаунт и собственные ограничения Google могут давать похожие внешне ошибки.'
      ]},
      {heading:'Как сообщить об ошибке в поддержку',paragraphs:[
        'Опишите операционную систему, используемую сеть и этап, на котором происходит сбой. Достаточно текста ошибки и времени появления; секреты, файлы проекта и токены отправлять не нужно.',
        'Официальные сведения о платформе публикует Google. MNEBYVPN не связан с Google и не управляет доступностью её продуктов.'
      ]}
    ],
    faq:[
      {question:'Antigravity и Gemini — это одно и то же?',answer:'Нет. Gemini — семейство ИИ-продуктов и моделей Google, а Antigravity — отдельная платформа разработки с ИИ-агентами.'},
      {question:'Почему вход проходит, но агент не отвечает?',answer:'Авторизация и работа агента используют разные операции. Проверьте сеть, статус сервисов Google и сообщения приложения на этапе выполнения задачи.'}
    ]
  },
  {
    path:'/telegram-proxy',label:'Прокси Telegram',title:'Прокси для Telegram — настройка и отличие от VPN | MNEBYVPN',
    description:'Для чего нужен Telegram-прокси, как подключить персональную ссылку, чем прокси Telegram отличается от VPN и что проверить при ошибке соединения.',
    headline:'Прокси Telegram: связь без постоянного VPN',
    lead:'Прокси Telegram — отдельный режим соединения для Telegram. Он не заменяет VPN для остальных приложений. В экосистеме MNEBYVPN прокси дополняет Smart DNS и VPN.',
    sections:[
      {heading:'Зачем нужен прокси в Telegram',paragraphs:[
        'При проблемах с подключением Telegram может использовать настроенный прокси-сервер. Это соединение относится к самому Telegram и не означает перенаправление всего трафика смартфона.',
        'Если не загружаются сайты в браузере или другое приложение, проверьте Smart DNS либо VPN — настройки прокси Telegram на них не распространяются.'
      ]},
      {heading:'Как подключить персональный доступ',paragraphs:[
        'Получите ссылку прокси в личном кабинете или в боте MNEBYVPN, откройте её в Telegram и подтвердите добавление. Проверьте соединение в настройках приложения.',
        'Ссылка персональная; не публикуйте её в чатах и не передавайте посторонним. При смене устройства пользуйтесь актуальными инструкциями в своём аккаунте.'
      ]},
      {heading:'Если Telegram не подключается',paragraphs:[
        'Проверьте обычную мобильную сеть или Wi-Fi, срок доступа, актуальность Telegram и статус самого прокси. Если проблема повторяется, напишите в поддержку.',
        'VPN может быть резервным вариантом, если конкретная сеть мешает работе прокси. Возможность соединения всегда зависит от текущих условий сети.'
      ]}
    ],
    faq:[
      {question:'Прокси Telegram ускоряет весь интернет?',answer:'Нет. Прокси Telegram не является общесистемным VPN и обычно не изменяет маршруты других приложений.'},
      {question:'Нужен ли VPN для Telegram при работающем прокси?',answer:'Не обязательно. Если прокси Telegram подключается и сообщения проходят, отдельно включать VPN только ради Telegram может не потребоваться.'}
    ]
  }
] as const;

export const SEO_REFERENCES:Readonly<Record<string,ReadonlyArray<{title:string;url:string}>>>=Object.freeze({
  '/vpn':[
    {title:'INCY — официальные версии клиента',url:'https://github.com/INCY-DEV/incy-platforms/releases'},
    {title:'Karing для iPhone — App Store',url:'https://apps.apple.com/ru/app/karing/id6472431552'},
  ],
  '/smart-dns':[
    {title:'Android Developers — особенности Private DNS',url:'https://developer.android.com/privacy-and-security/risks/bad-dns'},
    {title:'Apple Support — профиль настроек DNS',url:'https://support.apple.com/en-lamr/guide/deployment/dep86469ba99/web'},
  ],
  '/chatgpt':[
    {title:'OpenAI — состояние ChatGPT',url:'https://status.openai.com/'},
    {title:'OpenAI — поддерживаемые страны и территории',url:'https://help.openai.com/en/articles/7947663-chatgpt-and-openai-api-supported-countries-and-territories'},
  ],
  '/claude':[
    {title:'Anthropic — состояние Claude',url:'https://status.claude.com/'},
    {title:'Claude Code — официальная инструкция',url:'https://code.claude.com/docs/en/quickstart'},
  ],
  '/gemini':[
    {title:'Google — официальный сайт Gemini',url:'https://gemini.google.com/'},
    {title:'Google — доступность Gemini по странам',url:'https://support.google.com/gemini/answer/13575153?hl=ru'},
  ],
  '/google-antigravity':[
    {title:'Google Antigravity — официальная инструкция',url:'https://antigravity.google/docs/getting-started'},
  ],
  '/telegram-proxy':[
    {title:'Telegram — документация MTProto Proxy',url:'https://core.telegram.org/proxy'},
    {title:'Telegram — формат ссылок на прокси',url:'https://core.telegram.org/api/links'},
  ],
});

const ORIGIN='https://mnebyvpn.site';
function esc(s:string):string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function ldJson(value:unknown):string {
  return JSON.stringify(value).replace(/</g,'\\u003c');
}
export function renderSeoPage(path:string):string|null {
  const page=SEO_PAGES.find(item=>item.path===path);
  if(!page)return null;
  const url=ORIGIN+page.path;
  const links=SEO_PAGES.filter(item=>item.path!==page.path)
    .map(item=>'<a class="seo-chip" href="'+item.path+'">'+esc(item.label)+'</a>').join('');
  const sections=page.sections.map(s=>'<section class="seo-section"><h2>'+esc(s.heading)+'</h2>'+
    s.paragraphs.map(p=>'<p>'+esc(p)+'</p>').join('')+
    (s.points?'<ul>'+s.points.map(p=>'<li>'+esc(p)+'</li>').join('')+'</ul>':'')+
    '</section>').join('');
  const faq=page.faq.map(item=>'<details class="seo-answer"><summary>'+esc(item.question)+
    '</summary><p>'+esc(item.answer)+'</p></details>').join('');
  const officialLinks=(SEO_REFERENCES[path]??[]).map(source=>
    '<li><a href="'+esc(source.url)+'" rel="noopener noreferrer">'+esc(source.title)+'</a></li>'
  ).join('');
  const diagnostics=(SEO_DIAGNOSTICS[path]??[]).map((item)=>
    '<article class="seo-diagnostic-card"><h3>'+esc(item.symptom)+'</h3>'+
    '<p><strong>Что это может означать.</strong> '+esc(item.meaning)+'</p>'+
    '<p><strong>Что проверить дальше.</strong> '+esc(item.next)+'</p></article>'
  ).join('');
  const schema={
    '@context':'https://schema.org',
    '@graph':[
      {'@type':'WebPage','@id':url+'#webpage','url':url,'name':page.title,
        'description':page.description,'inLanguage':'ru-RU',
        'isPartOf':{'@id':ORIGIN+'/#website'}},
      {'@type':'BreadcrumbList','itemListElement':[
        {'@type':'ListItem','position':1,'name':'Главная','item':ORIGIN+'/'},
        {'@type':'ListItem','position':2,'name':page.label,'item':url}
      ]}
    ]
  };
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta name="theme-color" content="#080c20">'+
    '<title>'+esc(page.title)+'</title>'+
    '<meta name="description" content="'+esc(page.description)+'">'+
    '<link rel="canonical" href="'+url+'">'+
    '<meta property="og:type" content="article">'+
    '<meta property="og:locale" content="ru_RU">'+
    '<meta property="og:site_name" content="MNEBYVPN">'+
    '<meta property="og:title" content="'+esc(page.title)+'">'+
    '<meta property="og:description" content="'+esc(page.description)+'">'+
    '<meta property="og:url" content="'+url+'">'+
    '<meta property="og:image" content="'+ORIGIN+'/brand-avatar.webp">'+
    '<meta name="twitter:card" content="summary">'+
    '<link rel="icon" type="image/webp" href="/brand-avatar.webp">'+
    '<link rel="stylesheet" href="/site.css">'+
    '<link rel="stylesheet" href="/seo-pages.css">'+
    '<script type="application/ld+json">'+ldJson(schema)+'</script></head><body>'+
    '<header class="header"><div class="shell seo-header"><a class="brand" href="/">'+
    '<img class="brand-avatar" alt="" src="/brand-avatar.webp" width="34" height="34">'+
    '<span class="brand-text">MNEBY<span>VPN</span></span></a>'+
    '<nav aria-label="Навигация"><a href="/">Главная</a><a href="/#plans">Тарифы</a>'+
    '<a href="/#contact-support">Поддержка</a></nav></div></header>'+
    '<main class="shell seo-page"><nav class="seo-crumbs" aria-label="Хлебные крошки">'+
    '<a href="/">Главная</a><span aria-hidden="true">/</span><span>'+esc(page.label)+'</span></nav>'+
    '<div class="seo-top"><p class="seo-kicker">MNEBYVPN · ПОМОЩЬ С ПОДКЛЮЧЕНИЕМ</p>'+
    '<h1>'+esc(page.headline)+'</h1><p class="seo-lead">'+esc(page.lead)+'</p>'+
    '<a class="button button-primary" href="/#plans">Посмотреть варианты доступа</a></div>'+
    '<section class="seo-diagnostics" aria-label="Разбор частых симптомов">'+
    '<h2>Не работает? Определите причину по признакам</h2>'+
    '<p class="seo-diagnostic-intro">Похожие ошибки могут возникать на разных этапах: в сети, в приложении или в аккаунте. Эти проверки помогут понять, куда смотреть дальше, но не заменяют диагностику сервиса.</p>'+
    '<div class="seo-diagnostic-grid">'+diagnostics+'</div></section>'+
    '<article class="seo-article">'+sections+'</article>'+
    '<section class="seo-faq" aria-label="Вопросы и ответы"><h2>Частые вопросы</h2>'+faq+'</section>'+
    '<section class="seo-sources" aria-label="Официальные источники"><h2>Официальные источники</h2>'+
    '<p>Документация и страницы владельцев сервисов для самостоятельной проверки условий доступа и настройки.</p>'+
    '<ul>'+officialLinks+'</ul></section>'+
    '<aside class="seo-next"><h2>Другие инструкции</h2><div class="seo-chips">'+links+'</div>'+
    '<p>Выберите режим подключения, который подходит вашей сети. Доступность отдельных ресурсов зависит от сети, аккаунта и правил владельца сервиса.</p>'+
    '<a class="seo-support-link" href="/#contact-support">Задать вопрос поддержке</a></aside></main>'+
    '<footer class="seo-footer"><div class="shell"><span>MNEBYVPN · VPN, Smart DNS и Telegram-прокси</span>'+
    '<a href="/privacy">Обработка данных</a><a href="/terms">Оферта</a></div></footer>'+
    '</body></html>';
}
