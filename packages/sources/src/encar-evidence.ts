import {
  type EncarListing,
  SourceError,
  type VinListingDetails,
  type VinListingReport,
} from "@autodom/core";

export type EncarReportKind = "inspection" | "diagnostic";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= 512 ? result : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function date(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{8}$/u.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

export function encarDetails(base: Record<string, unknown>): VinListingDetails {
  const category = record(base.category);
  const spec = record(base.spec);
  const contact = record(base.contact);
  const details: VinListingDetails = {};
  const make = text(category?.manufacturerEnglishName) ?? text(category?.manufacturerName);
  const model = [
    text(category?.modelGroupEnglishName) ?? text(category?.modelName),
    text(category?.gradeEnglishName) ?? text(category?.gradeName),
    text(category?.gradeDetailEnglishName) ?? text(category?.gradeDetailName),
  ]
    .filter(Boolean)
    .join(" ");
  if (make) details.make = make;
  if (model && model.length <= 512) details.model = model;
  const year = category?.formYear;
  if (typeof year === "string" && /^\d{4}$/u.test(year) && Number(year) >= 1886)
    details.model_year = Number(year);
  const month = category?.yearMonth;
  if (typeof month === "string" && /^\d{6}$/u.test(month) && date(`${month}01`))
    details.first_registration_date = `${month.slice(0, 4)}-${month.slice(4)}`;
  const mileage = integer(spec?.mileage);
  if (mileage !== undefined) details.odometer = { value: mileage, unit: "km" };
  const displacement = integer(spec?.displacement);
  if (displacement !== undefined) details.engine = `${displacement} cc`;
  for (const [field, value] of [
    ["transmission", spec?.transmissionName],
    ["fuel", spec?.fuelName],
    ["body_style", spec?.bodyName],
    ["color", spec?.colorName],
  ] as const) {
    const observed = text(value);
    if (observed) details[field] = observed;
  }
  // Only the public broad region, never a seller's street address or contact identity.
  const region = typeof contact?.address === "string" ? contact.address.split(" ")[0] : undefined;
  if (
    region &&
    /^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)$/u.test(
      region,
    )
  )
    details.location = region;
  if (contact?.userType === "DEALER" || contact?.userType === "CLIENT")
    details.seller_type = contact.userType;
  // Encar advertises in 만원 (10,000 KRW); KRW has no fractional minor unit.
  const advertisement = record(base.advertisement);
  const price = advertisement?.price;
  if (
    advertisement?.advertisementType === "NORMAL" &&
    advertisement.leaseRentInfo == null &&
    typeof price === "number" &&
    price >= 0 &&
    Number.isSafeInteger(price * 10_000)
  )
    details.asking_price = { amount_minor: price * 10_000, currency: "KRW" };
  return details;
}

export function encarReportUrl(id: string, kind: EncarReportKind): string {
  return `https://api.encar.com/legacy/usedcar/${kind === "inspection" ? "inspect" : "diagnosis"}/${id}`;
}

const INNER_FIELDS = {
  selfCheckMotor: "Самодиагностика двигателя",
  selfCheckTransmission: "Самодиагностика трансмиссии",
  motorOperationStatus: "Работа двигателя",
  motorOilLeakLockerArmCover: "Утечка масла: клапанная крышка",
  motorOilLeakCylinderHeaderGasket: "Утечка масла: прокладка ГБЦ",
  motorOilLeakOilFan: "Утечка масла: поддон",
  motorOilFlowRate: "Уровень масла двигателя",
  motorWaterLeakCylinderHeaderGasket: "Утечка охлаждающей жидкости: ГБЦ",
  motorWaterLeakPump: "Утечка: водяной насос",
  motorWaterLeakRadiator: "Утечка: радиатор",
  motorWaterLeakCoolingRate: "Уровень охлаждающей жидкости",
  motorHighPressurePump: "Насос высокого давления",
  transAutoOilLeakage: "Утечка масла АКПП",
  transAutoOilFlowAndCondition: "Уровень и состояние масла АКПП",
  transAutoStatus: "Работа АКПП",
  transManualOilLeakage: "Утечка масла МКПП",
  transManualGearShifting: "Переключение передач МКПП",
  transManualFluidFlowAndCondition: "Уровень и состояние масла МКПП",
  transManualStatus: "Работа МКПП",
  powerClutchAssembly: "Сцепление",
  powerConstantVelocityJoint: "ШРУС",
  powerWeightedShaftAndBearing: "Карданный вал и подшипник",
  powerDifferentialGear: "Дифференциал",
  steeringPowerOilLeakage: "Утечка масла ГУР",
  steeringGear: "Рулевой механизм",
  steeringPump: "Насос ГУР",
  steeringJoint: "Рулевой шарнир",
  steeringPowerHighPressureHose: "Шланг высокого давления ГУР",
  steeringTieRodEndAndBallJoint: "Рулевой наконечник и шаровая опора",
  brakeMasterCylinderOilLeakage: "Утечка: главный тормозной цилиндр",
  brakeOilLeakage: "Утечка тормозной жидкости",
  brakeSystemStatus: "Тормозная система",
  electricGeneratorOutput: "Генератор",
  electricStarterMotor: "Стартер",
  electricWiperMotorFunction: "Мотор стеклоочистителя",
  electricIndoorBlowerMotor: "Вентилятор салона",
  electricRadiatorFanMotor: "Вентилятор радиатора",
  electricWindowMotor: "Стеклоподъёмники",
  otherFuelLeaks: "Утечка топлива",
  highPowerChargingInsulatedStatus: "Изоляция высоковольтной зарядной системы",
  highPowerBatteryIsolationStatus: "Изоляция высоковольтной батареи",
  highPowerWiringStatus: "Высоковольтная проводка",
} as const;

const DIAGNOSIS_PANELS = {
  FRONT_DOOR_LEFT: "Передняя левая дверь",
  BACK_DOOR_LEFT: "Задняя левая дверь",
  TRUNK_LID: "Крышка багажника",
  BACK_DOOR_RIGHT: "Задняя правая дверь",
  FRONT_DOOR_RIGHT: "Передняя правая дверь",
  HOOD: "Капот",
  FRONT_FENDER_RIGHT: "Переднее правое крыло",
  FRONT_FENDER_LEFT: "Переднее левое крыло",
} as const;

const STATUS_LABELS: Readonly<Record<string, string>> = {
  GOOD: "исправно",
  NORMAL: "норма",
  NONE: "не выявлено",
  ADEQUATE: "в норме",
  Y: "да",
  N: "нет",
};

/** Parse only the observed legacy report contracts; never recursively flatten source JSON. */
export function parseEncarReport(
  body: string,
  listing: EncarListing,
  kind: EncarReportKind,
): VinListingReport {
  const document = record(JSON.parse(body));
  if (!document) throw new SourceError("Encar report structure unavailable");
  const report: VinListingReport = {
    kind,
    status: "available",
    source_url: encarReportUrl(listing.id, kind),
    partial: false,
    checked_at: Math.floor(Date.now() / 1000),
    report_date: null,
    facts: [],
  };
  const facts: { section: string; label: string; value: string }[] = [];
  const add = (section: string, label: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return;
    const observed =
      typeof value === "boolean" || typeof value === "number" ? String(value) : text(value);
    if (!observed) {
      report.partial = true;
      return;
    }
    if (facts.length === 80) {
      report.partial = true;
      return;
    }
    if (observed.length > 384) report.partial = true;
    const translated = Object.hasOwn(STATUS_LABELS, observed) ? STATUS_LABELS[observed] : undefined;
    facts.push({
      section,
      label,
      value: translated ? `${translated} (${observed})` : observed.slice(0, 384),
    });
  };
  if (kind === "inspection") {
    const car = record(document.carSaleDto);
    const master = record(document.master);
    if (
      car?.carId !== Number(listing.id) ||
      car.vehicleIdNo !== listing.vin ||
      master?.rgsid !== Number(listing.id) ||
      master.carregiStration !== listing.vin
    )
      throw new SourceError("Encar inspection identity unverified");
    report.report_date = date(master.issuedt);
    add("Автомобиль", "Первая регистрация", date(master.firstregdt));
    const mileage = integer(master.mileage);
    if (mileage !== undefined) add("Автомобиль", "Пробег в акте (км)", mileage);
    add("Автомобиль", "Модель двигателя", master.motorType);
    add("Автомобиль", "Трансмиссия", master.transmission);
    for (const [field, label] of [
      ["boardState", "Состояние одометра"],
      ["mileageState", "Достоверность пробега"],
      ["carstate", "Состояние автомобиля"],
      ["accyn", "ДТП по акту"],
      ["simpleRepair", "Простой ремонт по акту"],
      ["waterlogyn", "Затопление по акту"],
      ["tuningyn", "Тюнинг по акту"],
      ["coout", "Выбросы CO"],
      ["hcout", "Выбросы HC"],
      ["smout", "Дымность"],
    ] as const)
      add("Осмотр", label, master[field]);
    const inner = record(document.inner);
    for (const [field, label] of Object.entries(INNER_FIELDS))
      add("Технический осмотр", label, inner?.[field]);
    // Unknown technical structures and free-form comments are deliberately not disclosed.
    if (
      !inner ||
      document.outer != null ||
      document.etc != null ||
      document.img != null ||
      (typeof master.comments === "string" && master.comments.trim()) ||
      Object.keys(inner).some((key) => !Object.hasOwn(INNER_FIELDS, key))
    )
      report.partial = true;
  } else {
    // The report itself supplies carId; its VIN binding is the already confirmed canonical listing.
    if (document.carId !== Number(listing.id) || !Array.isArray(document.items))
      throw new SourceError("Encar diagnosis identity unverified");
    const issued = integer(document.diagnosisDt);
    if (issued !== undefined && issued <= 253_402_268_399_999) {
      // Source report dates are Korean local dates, not the date of this lookup.
      report.report_date = new Date(issued + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
    const seen = new Set<string>();
    for (const item of document.items) {
      const panel = record(item);
      const name = panel?.name;
      if (typeof name !== "string" || !Object.hasOwn(DIAGNOSIS_PANELS, name) || seen.has(name)) {
        report.partial = true;
        continue;
      }
      seen.add(name);
      add(
        "Диагностика кузова",
        DIAGNOSIS_PANELS[name as keyof typeof DIAGNOSIS_PANELS],
        panel?.resultCd,
      );
      if (!text(panel?.resultCd)) report.partial = true;
      if (panel?.result != null) report.partial = true;
    }
  }
  if (!facts.length) throw new SourceError("Encar report contains no verified technical facts");
  report.facts = facts;
  return report;
}
