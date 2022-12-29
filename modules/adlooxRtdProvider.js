/**
 * This module adds the Adloox provider to the real time data module
 * This module adds the [Adloox]{@link https://www.adloox.com/} provider to the real time data module
 * The {@link module:modules/realTimeData} module is required
 * The module will fetch segments from Adloox's server
 * @module modules/adlooxRtdProvider
 * @requires module:modules/realTimeData
 * @requires module:modules/adlooxAnalyticsAdapter
 * @optional module:modules/intersectionRtdProvider
 */

/* eslint standard/no-callback-literal: "off" */
/* eslint prebid/validate-imports: "off" */

import {command as analyticsCommand, COMMAND} from './adlooxAnalyticsAdapter.js';
import {submodule} from '../src/hook.js';
import {ajax} from '../src/ajax.js';
import {getGlobal} from '../src/prebidGlobal.js';
import {getRefererInfo} from '../src/refererDetection.js';
import {
  _each,
  _map,
  buildUrl,
  deepAccess,
  deepSetValue,
  getGptSlotInfoForAdUnitCode,
  isArray,
  isBoolean,
  isEmpty,
  isInteger,
  isPlainObject,
  logError,
  logInfo,
  logWarn,
  mergeDeep,
  parseUrl,
  safeJSONParse
} from '../src/utils.js';

const MODULE_NAME = 'adloox';
const MODULE = `${MODULE_NAME}RtdProvider`;

const API_ORIGIN = 'https://p.adlooxtracking.com';
const SEGMENT_HISTORIC = { 'a': 'aud', 'd': 'dis', 'v': 'vid' };

const ADSERVER_TARGETING_PREFIX = 'adl';

function init(config, userConsent) {
  logInfo(MODULE, 'init', config, userConsent);

  if (!isPlainObject(config)) {
    logError(MODULE, 'missing config');
    return false;
  }
  if (config.params === undefined) config.params = {};
  if (!(isPlainObject(config.params))) {
    logError(MODULE, 'invalid params');
    return false;
  }
  if (!(config.params.imps === undefined || (isInteger(config.params.imps) && config.params.imps > 0))) {
    logError(MODULE, 'invalid imps params value');
    return false;
  }
  if (!(config.params.freqcap_ip === undefined || (isInteger(config.params.freqcap_ip) && config.params.freqcap_ip >= 0))) {
    logError(MODULE, 'invalid freqcap_ip params value');
    return false;
  }
  if (!(config.params.freqcap_ipua === undefined || (isInteger(config.params.freqcap_ipua) && config.params.freqcap_ipua >= 0))) {
    logError(MODULE, 'invalid freqcap_ipua params value');
    return false;
  }
  if (!(config.params.thresholds === undefined || (isArray(config.params.thresholds) && config.params.thresholds.every(x => isInteger(x) && x > 0 && x <= 100)))) {
    logError(MODULE, 'invalid thresholds params value');
    return false;
  }
  if (!(config.params.slotinpath === undefined || isBoolean(config.params.slotinpath))) {
    logError(MODULE, 'invalid slotinpath params value');
    return false;
  }
  // legacy/deprecated configuration code path
  if (!(config.params.params === undefined || (isPlainObject(config.params.params) && isInteger(config.params.params.clientid) && isInteger(config.params.params.tagid) && isInteger(config.params.params.platformid)))) {
    logError(MODULE, 'invalid subsection params block');
    return false;
  }

  config.params.thresholds = config.params.thresholds || [ 50, 60, 70, 80, 90 ];

  function analyticsConfigCallback(data) {
    config = mergeDeep(config.params, data);
  }
  if (config.params.params) {
    logWarn(MODULE, `legacy/deprecated configuration (please migrate to ${MODULE_NAME}AnalyticsAdapter)`);
    analyticsConfigCallback(config.params.params);
  } else {
    analyticsCommand(COMMAND.CONFIG, null, analyticsConfigCallback);
  }

  return true;
}

function getBidRequestData(reqBidsConfigObj, callback, config, userConsent) {
  const { site: ortb2site, user: ortb2user } = reqBidsConfigObj.ortb2Fragments.global;

  const adUnitCodes = reqBidsConfigObj.adUnitCodes;
  if (isEmpty(adUnitCodes) && config._fpd?.ok) return callback();

  const adUnits = reqBidsConfigObj.adUnits || getGlobal().adUnits.filter(unit => adUnitCodes.includes(unit.code));
  // gptPreAuction runs *after* RTD so pbadslot may not be populated... (╯°□°)╯ ┻━┻
  // N.B. walk over adUnitCodes to maintain ordering
  const adUnitsGPIDs = adUnitCodes.map(code => {
    const unit = adUnits.find(unit => unit.code == code);
    return deepAccess(unit, 'ortb2Imp.ext.gpid') ||
           deepAccess(unit, 'ortb2Imp.ext.data.pbadslot') ||
           getGptSlotInfoForAdUnitCode(unit.code).gptSlot ||
           unit.code;
  });

  const refererInfo = getRefererInfo();
  // buildUrl creates PHP style multi-parameters and includes undefined... (╯°□°)╯ ┻━┻
  const url = buildUrl(mergeDeep(parseUrl(`${API_ORIGIN}/q`), { search: {
    'v': `pbjs-${getGlobal().version}`,
    'c': config.params.clientid,
    'p': config.params.platformid,
    't': config.params.tagid,
    'imp': config.params.imps,
    'fc_ip': config.params.freqcap_ip,
    'fc_ipua': config.params.freqcap_ipua,
    'pn': (refererInfo.page || '').substr(0, 300).split(/[?#]/)[0],
    's': _map(adUnitsGPIDs, function(v, i) {
      const ref = [ v ];
      if (!config.params.slotinpath && v != adUnitCodes[i]) ref.push(adUnitCodes[i]);
      return ref.join('\t', v);
    })
  } })).replace(/\[\]|[&?][^&?]+=undefined/g, '');

  ajax(url,
    function(responseText, q) {
      function val(v, k) {
        if (!(SEGMENT_HISTORIC[k] && v >= 0)) return v;
        return config.params.thresholds.filter(t => t <= v);
      }

      const response = safeJSONParse(responseText);
      if (!response) {
        logError(MODULE, 'unexpected response');
        return callback();
      }

      _each(response, function(v0, k0) {
        if (k0 == '_') return;
        const k = SEGMENT_HISTORIC[k0] || k0;
        const v = val(v0, k0);
        deepSetValue(k == k0 ? ortb2user : ortb2site, `ext.data.${MODULE_NAME}_rtd.${k}`, v);
      });

      _each(response._, function(segments, i) {
        // N.B. walk over adUnitCodes to maintain ordering
        const code = adUnitCodes[i];
        const unit = adUnits.find(unit => unit.code == code);
        _each(segments, function(v0, k0) {
          const k = SEGMENT_HISTORIC[k0] || k0;
          const v = val(v0, k0);
          deepSetValue(unit, `ortb2Imp.ext.data.${MODULE_NAME}_rtd.${k}`, v);
        });
      });

      deepSetValue(ortb2site, `ext.data.${MODULE_NAME}_rtd.ok`, true);

      // used by getTargetingData as auction.getFPD() is not for us
      Object.defineProperty(config, '_fpd', {
        value: mergeDeep(
          deepAccess(ortb2site, `ext.data.${MODULE_NAME}_rtd`),
          deepAccess(ortb2user, `ext.data.${MODULE_NAME}_rtd`)),
        writable: true
      });

      callback();
    }
  );
}

function getTargetingData(adUnitArray, config, userConsent) {
  function val(v) {
    if (isArray(v) && v.length == 0) return undefined;
    if (isBoolean(v)) v = ~~v;
    if (!v) return undefined; // empty string and zero
    return v;
  }

  const targeting = {};

  const ortb2base = {};
  _each(config._fpd, function(v0, k) {
    const v = val(v0);
    if (v) ortb2base[`${ADSERVER_TARGETING_PREFIX}_${k}`] = v;
  });

  const adUnits = getGlobal().adUnits.filter(unit => adUnitArray.includes(unit.code));
  _each(adUnits, function(unit) {
    targeting[unit.code] = ortb2base;

    const ortb2imp = deepAccess(unit, `ortb2Imp.ext.data.${MODULE_NAME}_rtd`);
    _each(ortb2imp, function(v0, k) {
      const v = val(v0);
      if (v) targeting[unit.code][`${ADSERVER_TARGETING_PREFIX}_${k}`] = v;
    });

    // ATF results shamelessly exfiltrated from intersectionRtdProvider
    const bid = unit.bids.find(bid => !!bid.intersection);
    if (bid) {
      const v = val(config.params.thresholds.filter(t => t <= (bid.intersection.intersectionRatio * 100)));
      if (v) targeting[unit.code][`${ADSERVER_TARGETING_PREFIX}_atf`] = v;
    }
  });

  return targeting;
}

export const subModuleObj = {
  name: MODULE_NAME,
  init,
  getBidRequestData,
  getTargetingData
};

submodule('realTimeData', subModuleObj);
