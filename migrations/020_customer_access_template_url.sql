-- 020_customer_access_template_url.sql
-- Kundenbezogener Link zum Access-Request-Template.

ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS access_url TEXT NULL;

UPDATE public.customers
SET access_url = 'https://equinixinc.sharepoint.com/sites/Germany-FileShare-04%20Ops-IBX-FR2/FR2/Forms/AllItems.aspx?viewid=8d7ca311%2D3da1%2D4c84%2Dbc61%2Dc98401261bca&ct=1702968506944&or=Teams%2DHL&ga=1&LOF=1&id=%2Fsites%2FGermany%2DFileShare%2D04%20Ops%2DIBX%2DFR2%2FFR2%2FCampus%2F03%20Dokumentation%2F3%2D03%20Kunden%2F3%2D02%20Access%20Restriction%2FZutrittsprozeduren%2FFormulare%5FTemplates%2FSUSQUEHANNA%2FAccess%20Request%20for%20FR2OG%2DM1A2OC%20%20FR2OG%2DM4%2E5OC%20FR2EG%2DM5%2E11OC%20FR2OG%2DM5%2E09OC%20FR20G002100%20FR203FLX303%20%20%20on%20the%20Date%2Emsg&parent=%2Fsites%2FGermany%2DFileShare%2D04%20Ops%2DIBX%2DFR2%2FFR2%2FCampus%2F03%20Dokumentation%2F3%2D03%20Kunden%2F3%2D02%20Access%20Restriction%2FZutrittsprozeduren%2FFormulare%5FTemplates%2FSUSQUEHANNA'
WHERE LOWER(BTRIM(name)) = LOWER(BTRIM('FR2:OG:0512S1:Susquehanna International Securities Ltd'))
  AND NULLIF(BTRIM(access_url), '') IS NULL;
