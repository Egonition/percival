'use strict';
importScripts("constants.js");

const skills = {
  "6199": "Conjunction",
  "8000": "Tag team"
};

// Keyboard Commands
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-play-pause') {
    console.log('🎮 Toggle Play/Pause Hotkey Pressed');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return;

      chrome.storage.local.get(['isPlaying'], (data) => {
        const newState = !data.isPlaying;

        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'toggleAutomation',
          action: newState ? 'play' : 'pause'
        }).then(response => {
          console.log('✅ Toggle Response:', response);
          chrome.storage.local.set({ isPlaying: newState });

          // Notify Popup if Open
          chrome.runtime.sendMessage({
            type: 'playStateChanged',
            isPlaying: newState
          }).catch(() => {});
        }).catch(err => {
          console.log('Content Script Not Ready:', err);
        });
      });
    });
  }

  if (command === 'deactivate-all') {
    deactivateAll();
  }
});

// Deactivate All Features
function deactivateAll() {
  console.log('🔴 Deactivating All Features.');
  const allVal = Object.fromEntries(allKeys.map(key => [key, false]));
  chrome.storage.sync.set(allVal);
}

// Attack and Summon Reload
chrome.webRequest.onCompleted.addListener(
  (details) => {
    chrome.storage.sync.get(
      ["reloadSummon", "goBackOnSummon", "reloadAttack", "goBackOnAttack"],
      (data) => {
        const isSummon = details.url.includes("summon_result.json");
        const isAttack = details.url.includes("normal_attack_result.json");
        const delay = Math.random() * 500 + 500;

        if (isSummon) {
          if (data.reloadSummon) {
            setTimeout(() => chrome.tabs.reload(details.tabId), delay);
          } else if (data.goBackOnSummon) {
            setTimeout(() => {
              chrome.scripting.executeScript({
                target: { tabId: details.tabId },
                func: () => history.back()
              });
            }, delay);
          }
        }

        if (isAttack) {
          if (data.reloadAttack) {
            setTimeout(() => chrome.tabs.reload(details.tabId), delay);
          } else if (data.goBackOnAttack) {
            setTimeout(() => {
              chrome.scripting.executeScript({
                target: { tabId: details.tabId },
                func: () => history.back()
              });
            }, delay);
          }
        }
      }
    );
  },
  {
    urls: [
      "*://game.granbluefantasy.jp/rest/*/summon_result.json*",
      "*://game.granbluefantasy.jp/rest/*/normal_attack_result.json*"
    ]
  }
);

// Skill Reload
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const postedString = JSON.parse(
      decodeURIComponent(
        String.fromCharCode.apply(null, new Uint8Array(details.requestBody.raw[0].bytes))
      )
    );

    chrome.storage.sync.get("reloadSkill", (data) => {
      if (data.reloadSkill && Object.keys(skills).includes(postedString["ability_id"])) {
        chrome.tabs.reload(details.tabId);
      }
    });
  },
  {
    urls: [
      "*://game.granbluefantasy.jp/rest/*/ability_result.json*",
      "*://game.granbluefantasy.jp/rest/*/*/ability_result.json*"
    ]
  },
  ["requestBody"]
);

// Redirect Farm
function handleRedirectFarm(tabId) {
  chrome.storage.sync.get(["redirectFarm"], (data) => {
    if (!data.redirectFarm) return;

    console.log('🔀 Redirect Active.');
    chrome.bookmarks.search({ title: "farm" }, (result) => {
      if (result[0]?.url) {
        console.log('🔀 Redirecting to:', result[0].url);
        setTimeout(() => {
          chrome.tabs.update(tabId, { url: result[0].url });
        }, Math.random() * 500 + 500);
      }
    });
  });
}

// Redirect Farm (Normal Raid)
chrome.webRequest.onCompleted.addListener(
  (details) => handleRedirectFarm(details.tabId),
  {
    urls: [
      "*://game.granbluefantasy.jp/resultmulti/data/*",
      "*://game.granbluefantasy.jp/*result/*"
    ]
  }
);

// Redirect Farm (Guild War)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("#result_multi/")) {
    handleRedirectFarm(tabId);
  }
});

// Set Storage Defaults on Install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set(storageDefaults, () => {
    console.log('✅ Storage Defaults Applied:', storageDefaults);
  });

  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: "game.granbluefantasy.jp" }
          })
        ],
        actions: [new chrome.declarativeContent.ShowPageAction()]
      }
    ]);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'showNotification') {
    chrome.notifications.create({
      type:    'basic',
      iconUrl: 'images/get_started128.png',
      title:   msg.title,
      message: msg.message
    });
    respond({ success: true });
    return true;
  }
});