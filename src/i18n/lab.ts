import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./usage-zh.json";
void i18n.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  resources: { zh: { translation: zh } },
  interpolation: { escapeValue: false },
});
export default i18n;
