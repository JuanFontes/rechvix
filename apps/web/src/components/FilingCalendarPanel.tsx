import { useState } from "react";
import { useTranslation } from "react-i18next";
import layout from "../pages/DashboardPage.module.css";
import { hasFilingCalendar, toIso, upcomingFilings, type FilingItem } from "../lib/filingCalendar";
import ui from "./ui.module.css";

/** When the periodic tax returns for this company's country normally fall due. A reminder only: nothing is filed from here and the app
 *  does not know whether a return has been filed. Shown for countries that have a built-in calendar. */
export function FilingCalendarPanel({ country }: { country: string }) {
  const { t, i18n } = useTranslation();
  const [now] = useState(() => new Date());
  if (!hasFilingCalendar(country)) return null;
  const today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const items = upcomingFilings(country, today, 120);
  const fmt = (c: { y: number; m: number; d: number }) => new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(c.y, c.m - 1, c.d)));
  const period = (p: FilingItem["period"]) =>
    p.kind === "quarter" ? t("tax.filing.periodQuarter", { n: p.n, year: p.year })
    : p.kind === "month" ? t("tax.filing.periodMonth", { month: new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(p.year, p.n - 1, 1))), year: p.year })
    : t("tax.filing.periodYear", { year: p.year });

  return (
    <div className={layout.panel} aria-labelledby="filing-calendar-h">
      <h2 id="filing-calendar-h">{t("tax.filing.title")}</h2>
      <p className={ui.muted}>{t("tax.filing.help")}</p>
      {items.length === 0 ? <p>{t("tax.filing.none")}</p> : (
        <div className={ui.tableScroll} tabIndex={0}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th scope="col">{t("tax.filing.colReturn")}</th>
                <th scope="col">{t("tax.filing.colPeriod")}</th>
                <th scope="col">{t("tax.filing.colDue")}</th>
                <th scope="col">{t("tax.filing.colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.form}</strong> <span className={ui.muted}>{t(i.nameKey)}</span></td>
                  <td>{period(i.period)}</td>
                  <td><time dateTime={toIso(i.due)}>{fmt(i.due)}</time></td>
                  <td>
                    <span className={ui.badge} data-tone={i.daysLeft <= 7 ? "warning" : i.state === "open" ? "positive" : "neutral"}>
                      {i.daysLeft === 0 ? t("tax.filing.dueToday") : t(i.state === "open" ? "tax.filing.openDays" : "tax.filing.opensLater", { count: i.daysLeft, date: fmt(i.opens) })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={ui.muted}>{t("tax.filing.disclaimer")}</p>
    </div>
  );
}
