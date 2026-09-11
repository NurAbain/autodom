export type SourceGroup = "local" | "neighboring" | "korea" | "usa" | "property" | "history";

export interface SourceEvidence {
  url: string;
  checked_on: string;
  finding: string;
}

export interface SourceSpec {
  id: string;
  name: string;
  market: string;
  group: SourceGroup;
  hosts: readonly string[];
  /** Currencies handled by the adapter; empty means the source contract is unverified. */
  currencies: readonly string[];
  priority: "P0" | "P1" | "P2";
  listing_type: "classifieds" | "dealer_inventory" | "auction";
  adapter: "implemented" | "not_implemented";
  fields: {
    /** Adapter-supported fields, not a guarantee that every advertisement supplies a value. */
    available: readonly string[];
    requested: readonly string[];
    notes: string;
  };
  access: {
    method: "public_pages" | "public_api" | "partner_feed" | "contract";
    technical_status: "previously_verified" | "unverified";
    permission_status: "not_documented" | "agreement_required";
    approval_owner: string;
    terms_url: string | null;
    restrictions: readonly string[];
    blockers: readonly string[];
  };
  cost: {
    status: "unknown" | "published";
    details: string;
    url: string | null;
  };
  refresh: string;
  evidence: readonly SourceEvidence[];
}

const VEHICLE_FIELDS = [
  "source_id",
  "url",
  "title",
  "price",
  "currency",
  "year",
  "mileage",
  "body_type",
  "transmission",
  "city",
  "availability",
  "photos",
] as const;
const APPROVAL_OWNER =
  "Владелец проекта Autodom: согласование договора и прав на сбор/повторный показ";
const UNKNOWN_COST = {
  status: "unknown",
  details:
    "Стоимость лицензии/выгрузки и квоты не подтверждены; публичная страница не означает бесплатное использование данных.",
  url: null,
} as const;
const RUNTIME_REFRESH =
  "После включения: AUTODOM_REFRESH_SECONDS (по умолчанию 300 с) для первых AUTODOM_REFRESH_PAGES (3) страниц; повтор полного обхода через AUTODOM_FULL_REFRESH_SECONDS (86400 с) после завершения. Лимиты и задержки сохраняются. Это расписание Autodom, не SLA поставщика.";
const UNSCHEDULED =
  "Сбор не запланирован: сначала согласовать права, квоты и частоту обновления, затем реализовать адаптер.";
const NO_ADAPTER = "Нет подключённого адаптера и проверенной схемы данных.";
const NO_AGREEMENT =
  "Договор/письменное разрешение на автоматический сбор и повторный показ не зарегистрированы.";

// This is the only source inventory. An entry is not an access grant.
// Owner lifted the preparation-only hold on 2026-09-11; provider permissions remain unconfirmed.
export const SOURCES: readonly SourceSpec[] = [
  {
    id: "mashina.kg",
    name: "Mashina.kg",
    market: "KG",
    group: "local",
    hosts: ["mashina.kg"],
    currencies: ["USD", "KGS"],
    priority: "P0",
    listing_type: "classifieds",
    adapter: "implemented",
    fields: {
      available: [...VEHICLE_FIELDS, "published_at"],
      requested: [],
      notes:
        "RSC-каталог легковых автомобилей; марка/модель в заголовке, фото — первое доступное. Нет VIN, истории, телефонов и программ обмена. Отсутствующие значения остаются неизвестными.",
    },
    access: {
      method: "public_pages",
      technical_status: "previously_verified",
      permission_status: "agreement_required",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://mashina.kg/agreement",
      restrictions: [
        "Только через настроенные прокси; без прямого сетевого обхода.",
        "§14.5 опубликованного соглашения требует письменного разрешения на копирование/распространение; §14.8 — согласия автора на использование его данных.",
        "Robots не является лицензией. Включение владельцем не доказывает разрешение площадки.",
      ],
      blockers: [
        NO_AGREEMENT,
        "Уточнить авторитетную редакцию условий: текущая страница обозначена как адаптированная версия.",
        "Согласовать поля/фото, частоту запросов, удаление и коммерческие условия.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: RUNTIME_REFRESH,
    evidence: [
      {
        url: "https://trello.com/c/NqDJdj7R",
        checked_on: "2026-09-10",
        finding:
          "AUT-007: зафиксирован живой сбор 63 объявлений через прокси, 61 в наличии. Подтверждён технический доступ, а не договор с площадкой.",
      },
      {
        url: "https://mashina.kg/agreement",
        checked_on: "2026-09-11",
        finding:
          "Прочитаны §§14.5, 14.8, 16; письменное разрешение необходимо. Цены рекламных услуг не являются стоимостью лицензии на данные. Документ называет себя адаптированной версией.",
      },
      {
        url: "https://mashina.kg/robots.txt",
        checked_on: "2026-09-11",
        finding:
          "Прочитан: ограничения API, учётных/служебных путей и отдельных роботов; разрешение на повторное использование не установлено.",
      },
    ],
  },
  {
    id: "encar.com",
    name: "Encar",
    market: "KR",
    group: "korea",
    hosts: ["fem.encar.com"],
    currencies: ["KRW"],
    priority: "P1",
    listing_type: "classifieds",
    adapter: "implemented",
    fields: {
      available: [
        "source_id",
        "url",
        "title",
        "price",
        "currency",
        "year",
        "registration",
        "mileage",
        "city",
        "photos",
      ],
      requested: [],
      notes:
        "Корейские внутренние марки; Price в единицах 10000 KRW, регистрация отдельно от модельного года. Адаптер не переносит condition/флаги истории и не получает VIN-отчёт. Экспорт не подтверждён.",
    },
    access: {
      method: "public_api",
      technical_status: "previously_verified",
      permission_status: "agreement_required",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://fem.encar.com/policy/terms",
      restrictions: [
        "GET api.encar.com/search/car/list/general технически доступен, но это не согласованный публичный API для партнёров.",
        "Статья 15 доступной редакции условий сервиса покупки от 2025-01-02 требует разрешения на повторный показ. Полный текст текущих общих условий не получен.",
      ],
      blockers: [
        NO_AGREEMENT,
        "Запросить data partnership через price@encar.com, разрешённый интерфейс, поля, фото, квоты и актуальные общие условия.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: RUNTIME_REFRESH,
    evidence: [
      {
        url: "https://trello.com/c/IKNj9SsF",
        checked_on: "2026-09-10",
        finding:
          "В AUT-002 зафиксированы 20 проверенных объявлений через прокси и решение не включать иностранные источники.",
      },
      {
        url: "https://fem.encar.com/company/contact-us",
        checked_on: "2026-09-11",
        finding:
          "Прочитана официальная страница: партнёрство по ценам/данным через price@encar.com; это контакт, не выданная лицензия.",
      },
      {
        url: "https://www.encar.com/cs/cs_helpdesk.do?boardId=014&method=noticeRead&regid=280835",
        checked_on: "2026-09-11",
        finding:
          "Прочитана редакция сервиса покупки от 2025-01-02: статья 15 о предварительном разрешении на использование материалов.",
      },
      {
        url: "https://fem.encar.com/policy/terms",
        checked_on: "2026-09-11",
        finding:
          "Индекс указывает редакцию 2026-06-30, но содержательная часть текущих общих условий не отобразилась.",
      },
    ],
  },
  {
    id: "truecar.com",
    name: "TrueCar",
    market: "US",
    group: "usa",
    hosts: ["www.truecar.com"],
    currencies: ["USD"],
    priority: "P1",
    listing_type: "dealer_inventory",
    adapter: "implemented",
    fields: {
      available: [...VEHICLE_FIELDS, "vin_based_identity", "advertised_accident_history"],
      requested: [],
      notes:
        "VIN проверяется для идентификатора, но не сохраняется отдельным полем vin. Цена предложения дилера, не итог покупки. AUTODOM_TRUECAR_SEARCH_URL: исходно Toyota Camry, ZIP 10017, 75 миль, не вся страна. Неизвестная история ДТП не равна отсутствию ДТП.",
    },
    access: {
      method: "public_pages",
      technical_status: "previously_verified",
      permission_status: "agreement_required",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://www.truecar.com/terms/",
      restrictions: [
        "§4 условий от 2026-08-10 запрещает data mining/robots/extraction; коммерческое повторное использование требует предварительного письменного разрешения.",
        "Доставка, экспорт, налоги и юридическая чистота не подтверждены. История от AutoCheck на сайте не даёт права на отчёты AutoCheck.",
      ],
      blockers: [
        NO_AGREEMENT,
        "Уточнить через contact@truecar.com: лицензирование pricing information в FAQ не подтверждает доступность inventory API, прав на фото или истории.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: RUNTIME_REFRESH,
    evidence: [
      {
        url: "https://trello.com/c/IKNj9SsF",
        checked_on: "2026-09-10",
        finding:
          "AUT-002 фиксирует техническую доступность через прокси и решение «подготовить, но не запускать».",
      },
      {
        url: "https://www.truecar.com/terms/",
        checked_on: "2026-09-11",
        finding:
          "Прочитаны текущие условия от 2026-08-10: §4 ограничивает коммерческое использование и запрещает автоматическое извлечение; §8 называет AutoCheck.",
      },
      {
        url: "https://www.truecar.com/faq/",
        checked_on: "2026-09-11",
        finding:
          "FAQ предлагает обсуждать лицензию на ценовую информацию. Бесплатность для потребителя и еженедельное обновление pricing не являются ценой/SLA выгрузки объявлений.",
      },
    ],
  },
  {
    id: "bid.cars",
    name: "Bid.Cars · Copart / IAAI",
    market: "US",
    group: "usa",
    hosts: ["bid.cars"],
    currencies: ["USD"],
    priority: "P1",
    listing_type: "auction",
    adapter: "implemented",
    fields: {
      available: [
        ...VEHICLE_FIELDS,
        "vin",
        "auction",
        "lot",
        "current_bid",
        "final_bid",
        "buy_now",
        "auction_end",
        "damage",
        "documents",
      ],
      requested: [],
      notes:
        "Только лоты с подтверждённой площадкой США. Текущая/финальная ставка не является ценой покупки. В подбор попадает лишь активный Buy Now с подтверждённым будущим сроком UTC. Run and Drive — заявление аукциона, не гарантия.",
    },
    access: {
      method: "public_pages",
      technical_status: "previously_verified",
      permission_status: "agreement_required",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://bid.cars/terms_en.pdf",
      restrictions: [
        "Только английские публичные automobile-каталоги и карточки; без app/search/query.",
        "§15.2 условий не передаёт лицензию на материалы и базы. Калькулятор не подтверждает стоимость ввоза в Кыргызстан.",
        "Агрегация Copart/IAA не даёт Autodom прямого доступа к их базам.",
      ],
      blockers: [NO_AGREEMENT],
    },
    cost: {
      status: "unknown",
      details:
        "Лицензия на данные: цена неизвестна. Ссылаемый PDF от 2019-06-08 публикует Basic бесплатно и Premium 300 USD/год: это старые цены аккаунтов, не актуальная котировка и не разрешение на базы/выгрузку.",
      url: "https://bid.cars/terms_en.pdf",
    },
    refresh: RUNTIME_REFRESH,
    evidence: [
      {
        url: "https://trello.com/c/IKNj9SsF",
        checked_on: "2026-09-10",
        finding:
          "В AUT-002 подтверждены публичные каталоги/карточки и подготовленный адаптер; массовая выгрузка и повторный показ не согласованы.",
      },
      {
        url: "https://bid.cars/en/terms",
        checked_on: "2026-09-11",
        finding:
          "Текущая страница условий ссылается на английский PDF от 2019-06-08; актуальность всех его коммерческих условий отдельно не подтверждена.",
      },
      {
        url: "https://bid.cars/terms_en.pdf",
        checked_on: "2026-09-11",
        finding:
          "Прочитан: §15(2) не даёт прав/лицензий на материалы и базы; §§1,4 отделяют сервис сайта от договоров покупки/доставки. Поставщик в Польше, рынок поддержанного адаптера — США.",
      },
    ],
  },
  {
    id: "lalafo.kg",
    name: "Lalafo Кыргызстан",
    market: "KG",
    group: "local",
    hosts: ["lalafo.kg"],
    currencies: [],
    priority: "P0",
    listing_type: "classifieds",
    adapter: "not_implemented",
    fields: {
      available: [],
      requested: VEHICLE_FIELDS,
      notes:
        "Плановая валюта KGS, возможный USD не проверен. Схема, валюты/единицы выгрузки и автомобильный охват в Autodom не подтверждены.",
    },
    access: {
      method: "partner_feed",
      technical_status: "unverified",
      permission_status: "not_documented",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://lalafo.kg/page/user-agreement",
      restrictions: [
        "Запросить разрешённую выгрузку или согласование публичных страниц; наличие внутренних API не означает разрешения.",
      ],
      blockers: [
        NO_ADAPTER,
        NO_AGREEMENT,
        "Юридические страницы и контакты вернули HTTP 403; получить полные условия, согласованный канал и квоты без обхода ограничения.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: UNSCHEDULED,
    evidence: [
      {
        url: "https://lalafo.kg/page/user-agreement",
        checked_on: "2026-09-11",
        finding:
          "HTTP 403: текущие условия не прочитаны; страницы contacts и agreement-offer также недоступны. Тариф на выгрузку неизвестен.",
      },
      {
        url: "https://lalafo.kg/robots.txt",
        checked_on: "2026-09-11",
        finding:
          "Прочитан: ограничения служебных/платёжных путей. Отсутствие запрета на часть страниц не является разрешением на сбор.",
      },
    ],
  },
  {
    id: "kolesa.kz",
    name: "Kolesa.kz",
    market: "KZ",
    group: "neighboring",
    hosts: ["kolesa.kz"],
    currencies: [],
    priority: "P1",
    listing_type: "classifieds",
    adapter: "not_implemented",
    fields: {
      available: [],
      requested: VEHICLE_FIELDS,
      notes:
        "Плановая валюта KZT; реальные валюты/единицы выгрузки не проверены. Нет конвертации KZT и подтверждённого экспорта в Кыргызстан.",
    },
    access: {
      method: "partner_feed",
      technical_status: "unverified",
      permission_status: "not_documented",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://kolesa.kz/content/agreement/",
      restrictions: [
        "Нужны согласованные права доступа и повторного показа; не использовать внутренние API как публичную лицензию.",
      ],
      blockers: [
        NO_ADAPTER,
        NO_AGREEMENT,
        "Прямое чтение соглашения/robots завершилось тайм-аутом; текущие правила, коммерческие условия и разрешённый интерфейс нужно получить у поставщика.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: UNSCHEDULED,
    evidence: [
      {
        url: "https://kolesa.kz/content/agreement/",
        checked_on: "2026-09-11",
        finding:
          "Тайм-аут прямого чтения. Поисковые выдержки об ограничениях не считаются проверенными текущими условиями.",
      },
      {
        url: "https://crm.kolesa.kz/",
        checked_on: "2026-09-11",
        finding:
          "Доступна оболочка Kolesa PRO, без входа. Это не подтверждение общего API/экспорта или права на повторный показ.",
      },
    ],
  },
  {
    id: "auto.uz",
    name: "Auto.uz",
    market: "UZ",
    group: "neighboring",
    hosts: ["auto.uz"],
    currencies: [],
    priority: "P1",
    listing_type: "classifieds",
    adapter: "not_implemented",
    fields: {
      available: [],
      requested: VEHICLE_FIELDS,
      notes:
        "Новые автомобили дилеров и объявления б/у по описанию сайта. Плановая валюта UZS; валюта/единицы выгрузки, USD и схема не проверены. Конвертации UZS и подтверждённого экспорта нет.",
    },
    access: {
      method: "partner_feed",
      technical_status: "unverified",
      permission_status: "not_documented",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://auto.uz/ru/about/static",
      restrictions: [
        "Сначала согласовать разрешённую выгрузку, её состав и географию. Внутренние адреса backend на странице не являются документацией API.",
      ],
      blockers: [
        NO_ADAPTER,
        NO_AGREEMENT,
        "Запросить полные условия и разрешение через опубликованный контакт ООО MALUMOTNOMA: info@auto.uz; содержательная часть правил на сайте отсутствует.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: UNSCHEDULED,
    evidence: [
      {
        url: "https://auto.uz/ru/about/static",
        checked_on: "2026-09-11",
        finding:
          "Прочитаны контакты и описание новых/б/у автомобилей. Заголовок условий есть, юридический текст пуст; лицензия не проверена.",
      },
      {
        url: "https://auto.uz/robots.txt",
        checked_on: "2026-09-11",
        finding:
          "Прочитан: ограничения пользовательских/auth-путей. Частота запросов и лицензия на повторное использование не указаны.",
      },
    ],
  },
  {
    id: "copart.com",
    name: "Copart (прямой источник)",
    market: "US",
    group: "usa",
    hosts: ["www.copart.com"],
    currencies: [],
    priority: "P1",
    listing_type: "auction",
    adapter: "not_implemented",
    fields: {
      available: [],
      requested: [...VEHICLE_FIELDS, "vin", "lot", "buy_now", "auction_end", "damage", "documents"],
      notes:
        "CSV-справка перечисляет lot, время/место продажи, тип/марку/модель, кузов, цвет, повреждения, документы, одометр и топливо. Сам CSV, точные денежные/VIN/photo-колонки и единицы USD не проверялись.",
    },
    access: {
      method: "partner_feed",
      technical_status: "unverified",
      permission_status: "agreement_required",
      approval_owner: APPROVAL_OWNER,
      terms_url:
        "https://www.copart.com/Content/US/EN/buyer/Sales/Image-and-Data-License-Agreement",
      restrictions: [
        "Официальная CSV Sales Data доступна только на условиях Image and Data License Agreement.",
        "Членство/участие в торгах не доказывает права Autodom на нормализацию, объединение данных и выдачу в Telegram.",
      ],
      blockers: [
        NO_ADAPTER,
        NO_AGREEMENT,
        "Полный текст лицензии закрыт challenge. Проверить права на CSV/фото, изменение/объединение, приложения, хранение, квоты и стоимость до подключения.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: `${UNSCHEDULED} Справка Copart говорит о публикации CSV каждые 15 минут; это не разрешённый интервал загрузки Autodom и не гарантия SLA.`,
    evidence: [
      {
        url: "https://www.copart.com/content/us/en/buyer/sales/downloadsalesdata",
        checked_on: "2026-09-11",
        finding:
          "Прочитана официальная CSV-справка: состав полей, обновление каждые 15 минут и обязательность лицензии. Файл не скачивался.",
      },
      {
        url: "https://www.copart.com/Content/US/EN/buyer/Sales/Image-and-Data-License-Agreement",
        checked_on: "2026-09-11",
        finding:
          "Прямое чтение вернуло challenge; полный действующий договор не проверен. Индексированные выдержки не заменяют текст договора.",
      },
    ],
  },
  {
    id: "iaai.com",
    name: "IAA (прямой источник)",
    market: "US",
    group: "usa",
    hosts: ["www.iaai.com"],
    currencies: [],
    priority: "P1",
    listing_type: "auction",
    adapter: "not_implemented",
    fields: {
      available: [],
      requested: [...VEHICLE_FIELDS, "vin", "lot", "buy_now", "auction_end", "damage", "documents"],
      notes:
        "Плановая валюта USD, но прямые поля и единицы выгрузки не проверены. Данные Bid.Cars не доказывают договор или схему IAA.",
    },
    access: {
      method: "contract",
      technical_status: "unverified",
      permission_status: "agreement_required",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://www.iaai.com/US/TermsOfUse",
      restrictions: [
        "Требуются договор на данные, лимиты и разрешение на повторный показ отдельно от участия в торгах.",
        "B2B Connect не подтверждён как API покупательского каталога; нельзя подменять условия США канадскими.",
      ],
      blockers: [
        NO_ADAPTER,
        NO_AGREEMENT,
        "Полные условия США и документы B2B Connect недоступны; подтвердить наличие подходящего продукта/допуск, права, схему, цену и SLA напрямую.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: UNSCHEDULED,
    evidence: [
      {
        url: "https://www.iaai.com/US/marketing/terms-and-conditions",
        checked_on: "2026-09-11",
        finding:
          "Прочитан индекс US terms. Linked TermsOfUse вернул challenge; US/TermsOfUse содержит заголовок без юридического текста.",
      },
      {
        url: "https://b2bconnect.iaai.com/",
        checked_on: "2026-09-11",
        finding:
          "HTTP 403. Индексированное описание API stock/claims не доказывает существование лицензии/API для повторного показа объявлений.",
      },
    ],
  },
  {
    id: "kcar.com",
    name: "K Car",
    market: "KR",
    group: "korea",
    hosts: ["www.kcar.com"],
    currencies: [],
    priority: "P1",
    listing_type: "dealer_inventory",
    adapter: "not_implemented",
    fields: {
      available: [],
      requested: VEHICLE_FIELDS,
      notes:
        "Запрашиваемые поля; плановая валюта KRW. Реальные единицы/схема выгрузки, условия экспорта и SLA не проверены.",
    },
    access: {
      method: "partner_feed",
      technical_status: "unverified",
      permission_status: "not_documented",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://www.kcar.com/ci/atcl/ftAtcl",
      restrictions: [
        "Согласовать прямую партнёрскую выгрузку и права; публичный каталог не равен лицензии на сбор.",
      ],
      blockers: [
        NO_ADAPTER,
        NO_AGREEMENT,
        "Получить действующие условия и коммерческий контакт: открывается только оболочка страницы правил.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: UNSCHEDULED,
    evidence: [
      {
        url: "https://www.kcar.com/ci/atcl/ftAtcl",
        checked_on: "2026-09-11",
        finding:
          "Desktop/mobile страницы доступны только как навигация/метаданные без текста условий. Конкретные правовые ограничения и data API не подтверждены.",
      },
    ],
  },
  {
    id: "kbchachacha.com",
    name: "KB ChaChaCha",
    market: "KR",
    group: "korea",
    hosts: ["www.kbchachacha.com"],
    currencies: [],
    priority: "P1",
    listing_type: "classifieds",
    adapter: "not_implemented",
    fields: {
      available: [],
      requested: VEHICLE_FIELDS,
      notes:
        "Запрашиваемые поля; плановая валюта KRW. Реальные единицы/схема выгрузки, сведения диагностики, условия экспорта и SLA не проверены.",
    },
    access: {
      method: "partner_feed",
      technical_status: "unverified",
      permission_status: "agreement_required",
      approval_owner: APPROVAL_OWNER,
      terms_url: "https://www.kbchachacha.com/public/common/terms/view.kbc?termsGbnCode=118300",
      restrictions: [
        "Официальный footer прямо запрещает неразрешённое воспроизведение, распространение и scraping информации сайта/приложения.",
      ],
      blockers: [
        NO_ADAPTER,
        NO_AGREEMENT,
        "Запросить партнёрство через kpg051610@kbfg.com, полный текст условий и разрешённый интерфейс/поля, цену и квоты; наличие контакта не подтверждает API.",
      ],
    },
    cost: UNKNOWN_COST,
    refresh: UNSCHEDULED,
    evidence: [
      {
        url: "https://www.kbchachacha.com/public/suggest/partnership.kbc",
        checked_on: "2026-09-11",
        finding:
          "Прочитаны контакт партнёрства и прямой запрет неразрешённого копирования/распространения/scraping в footer.",
      },
      {
        url: "https://www.kbchachacha.com/public/common/terms/view.kbc?termsGbnCode=118300",
        checked_on: "2026-09-11",
        finding:
          "Индекс показывает редакцию 2025-07-28, но содержательный текст условий не отобразился; footer с ограничением доступен.",
      },
    ],
  },
];

export const COVERAGE: readonly { group: SourceGroup; name: string; gaps: readonly string[] }[] = [
  {
    group: "local",
    name: "Местные автомобильные площадки",
    gaps: [
      "Подключена только Mashina.kg; другие местные площадки не обеспечивают полный охват.",
      "Технический запуск Mashina.kg не подтверждает договор на повторный показ.",
    ],
  },
  {
    group: "neighboring",
    name: "Соседние автомобильные рынки",
    gaps: [
      "Кандидаты Казахстана и Узбекистана не подключены. Состав остальных соседних рынков не согласован.",
      "Конвертация KZT/UZS, экспорт и стоимость ввоза не реализованы; добавление кандидата не добавляет рынок в поиск.",
    ],
  },
  {
    group: "korea",
    name: "Корея",
    gaps: [
      "Encar подготовлен, но по решению владельца не включается без согласования; K Car и KB ChaChaCha не подключены.",
      "Экспортная доступность и полная стоимость покупки не подтверждены.",
    ],
  },
  {
    group: "usa",
    name: "США",
    gaps: [
      "TrueCar и Bid.Cars подготовлены, но по решению владельца не включаются без согласования.",
      "Прямых договоров/подключений Copart и IAA нет. Доступ к закрытым американским базам не подтверждён.",
      "Географически/модельно ограниченный поиск и аукционные лоты не означают охват всего рынка США.",
    ],
  },
  {
    group: "property",
    name: "Недвижимость застройщиков с приёмом авто",
    gaps: [
      "Нет зарегистрированных подтверждённых партнёров, выгрузок и программ автообмена; предложения пользователям не выдаются.",
      "Для включения нужны юридическое лицо, прямой договор/разрешённая выгрузка, ссылка на подтверждение приёма авто, дата проверки и срок действия условий.",
      "Отдельно подтвердить автомобиль как первоначальный взнос и автомобиль плюс доплата: оценка авто, объекты, валюта, минимальный взнос, ограничения и стоимость. До этого условия и дата подтверждения неизвестны.",
    ],
  },
  {
    group: "history",
    name: "История автомобиля",
    gaps: [
      "Ни один официальный провайдер VIN-отчётов, ограничений или реестров пробега не подключён.",
      "Сведения продавцов/аукционов не заменяют историю ДТП, залогов, запретов регистрации или подтверждённый пробег.",
      "Для каждого провайдера нужны договор, страны, типы проверок, цена отчёта, допустимость повторного показа и дата проверки покрытия.",
    ],
  },
];

export const VEHICLE_HISTORY_COVERAGE: readonly {
  markets: readonly string[];
  listing_sources: readonly { source_id: string; claims: readonly string[] }[];
  unavailable: readonly string[];
}[] = [
  {
    markets: ["KG"],
    listing_sources: [
      { source_id: "mashina.kg", claims: ["Заявленные продавцом характеристики и пробег"] },
    ],
    unavailable: [
      "Официальный VIN-отчёт",
      "История ДТП",
      "Подтверждённая история пробега",
      "Залоги и регистрационные ограничения",
    ],
  },
  {
    markets: ["KZ", "UZ"],
    listing_sources: [],
    unavailable: [
      "Объявления соседних рынков",
      "Официальный VIN-отчёт",
      "История ДТП",
      "Подтверждённая история пробега",
      "Залоги и регистрационные ограничения",
    ],
  },
  {
    markets: ["KR"],
    listing_sources: [],
    unavailable: [
      "Официальный VIN-отчёт",
      "Сведения об осмотре/истории: флаги Encar намеренно не переносятся адаптером",
      "Полная история ДТП",
      "Подтверждённая история пробега",
      "Юридические и экспортные ограничения",
    ],
  },
  {
    markets: ["US"],
    listing_sources: [
      {
        source_id: "truecar.com",
        claims: ["Заявленная история ДТП, только где сведения присутствуют в объявлении"],
      },
      {
        source_id: "bid.cars",
        claims: ["Аукционные сведения о повреждениях и документах, только где они присутствуют"],
      },
    ],
    unavailable: [
      "Прямой официальный VIN-отчёт",
      "Полная история ДТП",
      "Подтверждённая история пробега",
      "Юридическая чистота и экспортные ограничения",
    ],
  },
];
