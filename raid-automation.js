'use strict';

class RaidAutomator {

	// ==========================================================
	// Constructor
	// ==========================================================

	constructor() {
		this.settings = {
			autoRaid:    false,
			autoCombat:  false,
			quickAttack: false,
		};

		this.state = {
			active:                false,
			checkingButtons:       false,
			lastAction:            'Ready',
			totalClicks:           0,
			lastCheck:             0,
			autoCombatActive:      false,
			currentScreen:         'unknown',

			// Human Behavior Tracking
			lastHumanAction:       Date.now(),
			sessionStart:          Date.now(),
			totalRaids:            0,

			// URL Tracking
			lastUrl:               window.location.href,

			// Raid Completion Tracking
			lastRaidStartTime:     0,
			raidInProgress:        false,
			lastRaidCompletionLog: 0,

			// Combat Tracking
			autoClickAttempted:    false,
			hasSeenAutoButton:     false,
			battleScreenSince:     0,
      lastTurnSeen:          0,
      lastTurnChangedAt:     0,
			solvingCaptcha:        false
		};

		this.cooldowns = {
			ok:     0,
			attack: 0,
			auto:   0
		};

		this.timing = {
			COOLDOWN:           2000 + Math.random() * 3000,
			CHECK_INTERVAL:     800  + Math.random() * 700,
			RAID_LOAD_MIN:      9000,
			RAID_LOAD_MAX:      16000,
			MOUSE_STEPS_MIN:    8,
			MOUSE_STEPS_MAX:    20,
			STEP_DELAY_MIN:     10,
			STEP_DELAY_MAX:     30,
			HUMAN_DELAY_CHANCE: 0.3,
			HUMAN_DELAY_MIN:    500,
			HUMAN_DELAY_MAX:    3000,
		};

		this.breakManager  = new BreakManager({ enableBreaks: false });
		this.mouse         = new MouseSimulator(this.timing);
		this.captchaSolver = CONFIG.CAPSOLVER_API_KEY
			? new CaptchaSolver(CONFIG.CAPSOLVER_API_KEY)
			: null;

		this.observer = null;
		this.interval = null;
		this.init();
	}

	// ==========================================================
	// Initialization
	// ==========================================================

	async init() {
		this.state.solvingCaptcha = false;

		await this.loadSettings();
		this.breakManager.updateSettings({ enableBreaks: this.settings.enableBreaks });
		await this.loadBreakManagerState();
		this.setupBreakManagerState();
		await this.loadPersistentState();
		this.setupListeners();
		this.setupObserver();

		chrome.storage.local.get(['isPlaying'], (data) => {
			const shouldBePlaying = data.isPlaying !== undefined ? data.isPlaying : true;

			if (!shouldBePlaying) {
				this.updateStatus('Paused - Click Start to Resume');
				return;
			}

			const breakStatus = this.breakManager.getStatus();

			if (breakStatus.isOnBreak) {
				chrome.storage.local.set({ isPlaying: true });
				this.updateStatus('On Break - Will Resume Automatically');
			} else if (this.settings.autoRaid || this.settings.autoCombat) {
				this.start();
			} else {
				chrome.storage.local.set({ isPlaying: false });
				this.updateStatus('Enable Features to Start');
			}
		});
	}

	// ==========================================================
	// Storage
	// ==========================================================

	async loadSettings() {
		return new Promise(resolve => {
			chrome.storage.sync.get(['autoRaid', 'autoCombat', 'quickAttack', 'enableBreaks'], data => {
				this.settings.autoRaid     = data.autoRaid     || false;
				this.settings.autoCombat   = data.autoCombat   || false;
				this.settings.quickAttack  = data.quickAttack  || false;
				this.settings.enableBreaks = data.enableBreaks || false;
				resolve();
			});
		});
	}

	async loadPersistentState() {
		return new Promise(resolve => {
			chrome.storage.local.get(['raidAutomatorState'], data => {
				if (data.raidAutomatorState) {
					this.state.totalRaids   = data.raidAutomatorState.totalRaids   || 0;
					this.state.sessionStart = data.raidAutomatorState.sessionStart || Date.now();
				}
				resolve();
			});
		});
	}

	async savePersistentState() {
		chrome.storage.local.set({
			raidAutomatorState: {
				totalRaids:   this.state.totalRaids,
				sessionStart: this.state.sessionStart
			}
		});
	}

	async loadBreakManagerState() {
		return new Promise(resolve => {
			chrome.storage.local.get(['breakManagerState'], data => {
				if (data.breakManagerState && this.breakManager) {
					this.breakManager.loadState(data.breakManagerState);
					if (this.breakManager.settings.enableBreaks) {
						const status = this.breakManager.getStatus();
						console.log(`Raids Since Last Break: ${status.raidsSinceLastBreak}`);
					}
				}
				resolve();
			});
		});
	}

	async saveBreakManagerState() {
		if (!this.breakManager) return;
		chrome.storage.local.set({ breakManagerState: this.breakManager.saveState() });
	}

	// ==========================================================
	// Setup
	// ==========================================================

	setupBreakManagerState() {
		const originalOnRaidComplete = this.breakManager.onRaidComplete.bind(this.breakManager);
		this.breakManager.onRaidComplete = () => {
			const result = originalOnRaidComplete();
			if (result) this.saveBreakManagerState();
			return result;
		};

		this.breakManager.setOnBreakEndCallback(() => {
			this.saveBreakManagerState();
			this.updateStatus('Break Ended.');
			chrome.storage.local.get(['isPlaying'], (data) => {
				if (data.isPlaying && (this.settings.autoRaid || this.settings.autoCombat)) {
					this.start();
				}
			});
		});
	}

	setupListeners() {
		chrome.runtime.onMessage.addListener((msg, sender, respond) => {
			switch (msg.type) {
				case 'toggleAutomation':
					if (msg.action === 'play') {
						if (this.settings.autoRaid || this.settings.autoCombat) {
							this.start();
							respond({ success: true, status: 'Started' });
						} else {
							respond({ success: false, status: 'No Features Enabled' });
						}
					} else if (msg.action === 'pause') {
						this.stop();
						respond({ success: true, status: 'Paused' });
					}
					break;

				case 'updateSettings':
					this.updateSettings(msg);
					respond({ success: true });
					break;

				case 'getStatus':
					respond({
						type:                'raidStatusUpdate',
						active:              this.state.active,
						lastAction:          this.state.lastAction,
						totalClicks:         this.state.totalClicks,
						autoCombatActive:    this.state.autoCombatActive,
						currentScreen:       this.state.currentScreen,
						timestamp:           new Date().toLocaleTimeString(),
						totalRaids:          this.state.totalRaids,
						isOnBreak:           this.breakManager?.state?.isOnBreak           || false,
						timeLeft:            this.getBreakTimeLeft(),
						raidsSinceLastBreak: this.breakManager?.state?.raidsSinceLastBreak || 0
					});
					break;

				case 'forceEndBreak':
					if (this.breakManager) {
						const success = this.breakManager.forceEndBreak();
						respond({ success, message: success ? 'Break Force Ended' : 'No Active Break to End' });
						this.safeSendMessage({ type: 'breakStatusUpdate', isOnBreak: false, raidsSinceLastBreak: 0 });
						if (success && (this.settings.autoRaid || this.settings.autoCombat) && !this.state.active) {
							this.start();
						}
					} else {
						respond({ success: false, message: 'Break Manager Not Available' });
					}
					break;

				case 'getBreakStatus':
					respond({
						isOnBreak:           this.breakManager?.state?.isOnBreak           || false,
						timeLeft:            this.getBreakTimeLeft(),
						raidsSinceLastBreak: this.breakManager?.state?.raidsSinceLastBreak || 0,
						totalBreaks:         this.breakManager?.state?.totalBreaks         || 0
					});
					break;
			}
			return true;
		});

		chrome.storage.onChanged.addListener(changes => {
			if (changes.autoRaid || changes.autoCombat) {
				this.loadSettings().then(() => {
					if (this.state.active) this.updateStatus('Settings Updated');
				});
			}
			if (changes.enableBreaks && this.breakManager) {
				this.breakManager.updateSettings({ enableBreaks: changes.enableBreaks.newValue });
			}
		});
	}

	setupObserver() {
		this.observer = new MutationObserver((mutations) => {
			if (!this.state.active) return;

			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node.nodeType === 1 && this.hasBlockingPopup().found) {
						this.handlePopupDetected();
						return;
					}
				}
			}

			this.detectCurrentScreen();
			this.checkButtons();
		});

		this.observer.observe(document.body, { childList: true, subtree: true });
	}

	// ==========================================================
	// Screen Detection
	// ==========================================================

	detectCurrentScreen() {
		const breakStatus = this.breakManager.getStatus();
		if (breakStatus.isOnBreak) {
			this.state.currentScreen = 'break';
			return;
		}

		const previousScreen = this.state.currentScreen;
		const currentUrl     = window.location.href;
		const urlChanged     = this.state.lastUrl !== currentUrl;

		const okButton       = this.findQuestStartButton();
		const autoButton     = this.findAutoButton();
		const isStartScreen  = okButton   && this.isVisible(okButton);
		const isBattleScreen = autoButton && this.isVisible(autoButton);

		if (isStartScreen) {
			this.state.currentScreen = 'start';

			if (previousScreen === 'battle' && this.state.raidInProgress) {
				this.handleRaidCompletion();
			}

			this.state.raidInProgress     = false;
			this.state.autoCombatActive   = false;
			this.state.autoClickAttempted = false;
			this.state.hasSeenAutoButton  = false;

		} else if (isBattleScreen) {
			this.state.currentScreen = 'battle';

			if (!this.state.raidInProgress) {
				this.state.raidInProgress     = true;
				this.state.lastRaidStartTime  = Date.now();
				this.state.battleScreenSince  = Date.now();
				this.updateStatus(`Raid ${this.state.totalRaids + 1} In Progress...`);
				this.state.hasSeenAutoButton  = false;
				this.state.autoCombatActive   = false;
				this.state.autoClickAttempted = false;
			}

			if (!this.state.hasSeenAutoButton) this.state.hasSeenAutoButton = true;

		} else if (urlChanged && previousScreen === 'battle' && this.state.raidInProgress) {
			const wasBattleUrl   = this.state.lastUrl.includes('/#raid/')  || this.state.lastUrl.includes('/#battle/');
			const isNotBattleUrl = !currentUrl.includes('/#raid/')         && !currentUrl.includes('/#battle/');

			if (wasBattleUrl && isNotBattleUrl) {
				this.handleRaidCompletion();
				this.state.raidInProgress = false;
			}
		}

		this.state.lastUrl = currentUrl;
	}

	// ==========================================================
	// Raid Completion
	// ==========================================================

	handleRaidCompletion() {
		if (Date.now() - this.state.lastRaidCompletionLog < 1000) return;

		this.state.totalRaids++;
		this.state.lastRaidCompletionLog = Date.now();

		const raidDuration = Date.now() - this.state.lastRaidStartTime;
		const durationSecs = Math.round(raidDuration / 1000);

		this.updateStatus(`Raid ${this.state.totalRaids} Complete! (${durationSecs}s)`);
		console.log(`✅ Raid ${this.state.totalRaids} Completed in ${durationSecs}s`);

		if (this.breakManager.onRaidComplete()) {
			this.stop();
			this.updateStatus('⏸️ Taking a Break. Automation Paused.');
			const breakStatus = this.breakManager.getStatus();
			this.safeSendMessage({
				type:                'breakStatusUpdate',
				isOnBreak:           true,
				timeLeft:            breakStatus.timeLeft || 0,
				raidsSinceLastBreak: breakStatus.raidsSinceLastBreak || 0
			});
		}

		this.savePersistentState();
		this.saveBreakManagerState();

		this.state.raidDurations = this.state.raidDurations || [];
		this.state.raidDurations.push(raidDuration);

		if (this.state.raidDurations.length > 100) {
			this.state.raidDurations.shift();
		}

		if (this.state.totalRaids % 10 === 0) {
			const avg = this.state.raidDurations.reduce((a, b) => a + b, 0) / this.state.raidDurations.length;
			console.log(`📊 Average Raid Time: ${Math.round(avg / 1000)}s`);
		}
	}

	// ==========================================================
	// Popup Detection
	// ==========================================================

	hasBlockingPopup() {
		const popupHeader = document.querySelector('.prt-popup-header');
		if (!popupHeader || !this.isVisible(popupHeader)) return { found: false };

		const popupText = popupHeader.textContent?.trim() || '';
		if (!popupText.length) return { found: false };

		const text = popupText.toLowerCase();

		const popupTypes = [
			{
				type:  'APPopup',
				match: /\b(aap|ap)\b/i.test(popupText)
			},
			{
				type:  'BlockingPopup',
				match: text.includes('満員') || text.includes('満室')
			},
			{
				type:  'AccessVerification',
				match: text.includes('access')       || text.includes('verification') ||
				       text.includes('アクセス') || text.includes('確認')
			}
		];

		for (const { type, match } of popupTypes) {
			if (match) return { found: true, element: popupHeader, type, text: popupText };
		}

		return { found: false };
	}

	handlePopupDetected() {
		if (!this.state.active) return;

		const popupInfo = this.hasBlockingPopup();
		if (!popupInfo.found) return;

		if (popupInfo.type === 'AccessVerification') {
			this.handleCaptchaPopup();
			return;
		}

		this.stop();

		const statusMessage = `Popup Detected: ${popupInfo.text}`;
		this.updateStatus(statusMessage);

		const status = {
			type:       'popupDetected',
			active:     false,
			lastAction: statusMessage,
			popupInfo:  popupInfo,
			timestamp:  new Date().toLocaleTimeString()
		};

		this.safeSendMessage(status);
		chrome.storage.local.set({ raidStatus: status });
		console.warn('⚠️ Popup Detected - Automation Paused.', popupInfo.text);
	}

	// ==========================================================
	// Captcha
	// ==========================================================

	async handleCaptchaPopup(retryCount = 0) {
		if (!this.captchaSolver) {
			this.updateStatus('Captcha Detected - API Key Required to Auto-Solve.');
			this.stop();
			return;
		}

		if (this.state.solvingCaptcha) return;
		this.state.solvingCaptcha = true;

		const MAX_RETRIES = 3;

		console.log('🔐 Access Verification Detected - Attempting Captcha Solve...');
		this.updateStatus('Solving Captcha...');

		try {
			await this.sleep(800);

			const captchaImg = document.querySelector('.prt-popup-body img.image');

			if (!captchaImg) {
				console.warn('⚠️ Captcha Image Not Found.');
				this.updateStatus('Captcha Image Not Found - Manual Input Required.');
				this.stop();
				this.state.solvingCaptcha = false;
				return;
			}

			const solution = await this.captchaSolver.solve(captchaImg);

			if (solution) {
				await this.sleep(400 + Math.random() * 300);
				const submitted = await this.captchaSolver.submitSolution(solution);

				if (submitted) {
					this.updateStatus('Captcha Submitted - Resuming...');
					await this.sleep(2000);

					if (!this.hasBlockingPopup().found) {
						console.log('✅ Captcha Cleared - Automation Resuming.');
						this.state.solvingCaptcha = false;
						return;
					}

					if (retryCount < MAX_RETRIES) {
						console.warn(`⚠️ Retrying Captcha... (${retryCount + 1}/${MAX_RETRIES})`);
						this.state.solvingCaptcha = false;
						await this.sleep(1000);
						await this.handleCaptchaPopup(retryCount + 1);
						return;
					}

					console.warn('❌ Max Retries Reached - Pausing Automation.');
					this.updateStatus('Captcha Failed After 3 Attempts - Manual Input Required.');
					this.stop();
					return;
				}
			}

			console.warn('❌ Could Not Solve Captcha - Pausing Automation.');
			this.updateStatus('Captcha Solve Failed - Manual Input Required.');
			this.stop();

		} catch (error) {
			console.error('❌ Captcha Handler Error:', error);
			this.updateStatus('Captcha Error - Paused.');
			this.stop();
		}

		this.state.solvingCaptcha = false;
	}

	// ==========================================================
	// Automation Control
	// ==========================================================

	start() {
		if (this.state.active) return;

		const breakStatus = this.breakManager.getStatus();
		if (breakStatus.isOnBreak) {
			this.updateStatus('On Break - Cannot Start');
			return;
		}

		this.state.active = true;
		this.interval = setInterval(() => {
			this.detectCurrentScreen();
			this.checkButtons();
		}, this.timing.CHECK_INTERVAL);

		const features = [
			this.settings.autoRaid   && 'Start Raid',
			this.settings.autoCombat && 'Full Auto'
		].filter(Boolean).join(' + ');

		this.updateStatus(`Automation Active: ${features}`);
		chrome.storage.local.set({ isPlaying: true });
	}

	stop() {
		if (!this.state.active) return;

		this.state.active = false;
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		this.updateStatus('Automation Stopped');
		chrome.storage.local.set({ isPlaying: false });
	}

	updateSettings(msg) {
		this.settings.autoRaid    = msg.autoRaid    ?? this.settings.autoRaid;
		this.settings.autoCombat  = msg.autoCombat  ?? this.settings.autoCombat;
		this.settings.quickAttack = msg.quickAttack ?? this.settings.quickAttack;

		if (this.breakManager && msg.enableBreaks !== undefined) {
			this.breakManager.updateSettings({ enableBreaks: msg.enableBreaks });
		}

		if (this.state.active) this.updateStatus('Settings Updated');
	}

	// ==========================================================
	// Button Checks
	// ==========================================================

	async checkButtons() {
		if (this.state.checkingButtons) return;
		this.state.checkingButtons = true;
		try {
			const breakStatus = this.breakManager.getStatus();
			if (breakStatus.isOnBreak || !this.state.active) return;

			// Handle Dismissable Popups
			if (this.findDismissablePopup()) {
				const btn = this.findPopupButton();
				if (btn) {
					await this.mouse.simulateHumanClick(btn, 'Closing Popup');
				}
				return;
			}

			// Handle Dead Boss Scenario
			if (this.state.currentScreen === 'battle' && this.findDeadBoss()) {
				console.log('💀 Boss is Dead - Reloading Page...');
				this.updateStatus('Boss Dead - Reloading...');
				setTimeout(() => window.location.reload(), 1000 + Math.random() * 1000);
				return;
			}

			// Handle Blocking Popup
			if (this.hasBlockingPopup().found) {
				this.handlePopupDetected();
				return;
			}

			const now = Date.now();
			if (now - this.state.lastCheck < 500) return;
			this.state.lastCheck = now;

			// Start Raid
			if (this.settings.autoRaid && this.canClick('ok') && this.state.currentScreen === 'start') {
				const okButton = this.findQuestStartButton();
				if (okButton) {
					if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }
					await this.clickRaidStart(okButton);
				}
			}

			const battleSettled = Date.now() - this.state.battleScreenSince > 2000;

			const inBattle = this.state.currentScreen === 'battle' &&
			                 this.state.hasSeenAutoButton          &&
			                 !this.state.autoClickAttempted        &&
			                 !this.state.autoCombatActive          &&
			                 battleSettled;

			// Quick Attack
			if (this.settings.quickAttack && this.canClick('attack') && inBattle) {
				const attackButton = this.findAttackButton();
				if (attackButton) {
					if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }
					await this.clickQuickAttack(attackButton);
					return;
				}
			}

			// Auto Combat
			if (this.settings.autoCombat && this.canClick('auto') && inBattle) {
				const autoButton = this.findAutoButton();
				if (autoButton) {
					if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }
					await this.clickAutoCombat(autoButton);
				}
			}

      // Track Turn Progress
      if (this.state.autoCombatActive && this.state.currentScreen === 'battle') {
        const turnEl      = document.querySelector('#js-turn-num-count');
        const currentTurn = turnEl?.textContent?.trim() || '';

        if (currentTurn !== this.state.lastTurnSeen) {
          this.state.lastTurnSeen      = currentTurn;
          this.state.lastTurnChangedAt = Date.now();
        } else if (Date.now() - this.state.lastTurnChangedAt > 30000) {
          console.warn('⚠️ Turn Counter Stale - Reloading...');
          this.updateStatus('Battle Stuck - Reloading...');
          this.state.autoCombatActive  = false;
          this.state.lastTurnSeen      = '';
          this.state.lastTurnChangedAt = 0;
          setTimeout(() => window.location.reload(), 500);
          return;
        }
      }
		} finally {
			this.state.checkingButtons = false;
		}
	}

	// ==========================================================
	// Click Actions
	// ==========================================================

	async clickRaidStart(button) {
		if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }

		this.cooldowns.ok             = Date.now();
		this.state.autoCombatActive   = false;
		this.state.autoClickAttempted = false;

		this.updateStatus(`Starting Raid ${this.state.totalRaids + 1}...`);
		await this.savePersistentState();
		await this.saveBreakManagerState();

		if (Math.random() < this.timing.HUMAN_DELAY_CHANCE) {
			const delay = this.getRandomDelay(this.timing.HUMAN_DELAY_MIN, this.timing.HUMAN_DELAY_MAX);
			this.updateStatus(`Thinking... (+${Math.round(delay / 1000)}s)`);
			await this.sleep(delay);
			if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }
		}

		if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }

		await this.mouse.simulateHumanClick(button, 'OK', () => this.hasBlockingPopup().found);
		this.state.totalClicks++;
		this.updateStatus('Raid Started - Waiting for Battle Screen...');
	}

	async clickAutoCombat(button) {
		if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }

		this.state.autoClickAttempted = true;
		this.cooldowns.auto           = Date.now();

		if (Math.random() < this.timing.HUMAN_DELAY_CHANCE) {
			const delay = this.getRandomDelay(this.timing.HUMAN_DELAY_MIN, this.timing.HUMAN_DELAY_MAX);
			await this.sleep(delay);
			if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }
		}

		const { x, y } = this.mouse.getRandomClickPoint(button);
		await this.mouse.simulateHumanMouseMovement(x, y);
		await this.sleep(this.getRandomDelay(50, 200));
		await this.mouse.applyMicroAdjust(x, y);

		const clicked = await this.mouse.performSingleReliableClick(button, x, y, 'Auto Combat');
		this.state.autoCombatActive = true;
		this.state.totalClicks++;
		this.updateStatus(clicked ? 'Auto Combat Enabled' : 'Auto Combat Enabled.');
	}

	async clickQuickAttack(button) {
		if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }

		this.state.autoClickAttempted = true;
		this.cooldowns.auto           = Date.now();

		if (Math.random() < this.timing.HUMAN_DELAY_CHANCE) {
			const delay = this.getRandomDelay(this.timing.HUMAN_DELAY_MIN, this.timing.HUMAN_DELAY_MAX);
			await this.sleep(delay);
			if (this.hasBlockingPopup().found) { this.handlePopupDetected(); return; }
		}

		await this.mouse.simulateHumanClick(button, 'Quick Attack', () => this.hasBlockingPopup().found);
		this.state.autoCombatActive = true;
		this.state.totalClicks++;
		this.updateStatus('Quick Attack Used - Waiting for Completion');

		setTimeout(() => {
			this.state.autoCombatActive   = false;
			this.state.autoClickAttempted = false;
		}, 5000);
	}

	// ==========================================================
	// Element Finders
	// ==========================================================

  findQuestStartButton() {
    if (!this.isPageLoaded()) return null;

    const deckContainer  = document.querySelector('.prt-btn-deck');
    const questContainer = document.querySelector('.prt-set-quest');

    const b1 = deckContainer?.querySelector('.btn-usual-ok.se-quest-start');
    const b2 = deckContainer?.querySelector('.btn-usual-ok.btn-silent-se');
    const b3 = questContainer?.querySelector('.btn-quest-start.multi.se-quest-start');

    if (b1 && this.isVisible(b1)) return b1;
    if (b2 && this.isVisible(b2)) return b2;
    if (b3 && this.isVisible(b3)) return b3;

    return null;
  }

	findAttackButton() {
    if (!this.isPageLoaded()) return null;

    const container = document.querySelector('#cnt-raid-information');
    const btn       = container?.querySelector('.btn-attack-start');
    return btn && this.isVisible(btn) ? btn : null;
  }

	findAutoButton() {
    if (!this.isPageLoaded()) return null;

    const container = document.querySelector('.cnt-raid');
    const btn       = container?.querySelector('.btn-auto');
    return btn && this.isVisible(btn) ? btn : null;
  }

	findDeadBoss() {
    if (!this.isPageLoaded()) return false;

    const hpElement = document.getElementById('enemy-hp0');
    return hpElement && hpElement.textContent.trim() === '0';
  }

	findDismissablePopup() {
    if (!this.isPageLoaded()) return false;

    const popup = document.querySelector('.pop-usual');
    if (!popup) return false;

    const isBattleEnded = !!popup.querySelector('.txt-rematch-fail');
    const isExpGained   = popup.querySelector('.prt-popup-header')?.textContent?.trim() === 'EXP Gained';

    return isBattleEnded || isExpGained;
  }

	findPopupButton() {
    if (!this.isPageLoaded()) return null;

    const popup = document.querySelector('.pop-usual');
    if (!popup) return null;

    const isBattleEnded = !!popup.querySelector('.txt-rematch-fail');
    const isExpGained   = popup.querySelector('.prt-popup-header')?.textContent?.trim() === 'EXP Gained';

    if (!isBattleEnded && !isExpGained) return null;

    const btn = popup.querySelector('.btn-usual-ok, .btn-usual-close');
    return btn && this.isVisible(btn) ? btn : null;
  }

  isPageLoaded() {
    const contents = document.querySelector('.contents');
    return contents && contents.style.display !== 'none';
  }

	isVisible(element) {
		if (!element) return false;
		const style = window.getComputedStyle(element);
		const rect  = element.getBoundingClientRect();
		return style.display    !== 'none'   &&
		       style.visibility !== 'hidden' &&
		       rect.width  > 0 &&
		       rect.height > 0 &&
		       rect.top    >= 0 &&
		       rect.left   >= 0;
	}

	canClick(type) {
		return Date.now() - this.cooldowns[type] > this.timing.COOLDOWN;
	}

	// ==========================================================
	// Status & Messaging
	// ==========================================================

	buildStatus(lastAction) {
		const status = {
			type:             'raidStatusUpdate',
			active:           this.state.active,
			lastAction,
			totalClicks:      this.state.totalClicks,
			autoCombatActive: this.state.autoCombatActive,
			currentScreen:    this.state.currentScreen,
			totalRaids:       this.state.totalRaids,
			timestamp:        new Date().toLocaleTimeString()
		};

		if (this.breakManager) {
			Object.assign(status, this.breakManager.getStatus());
		}

		return status;
	}

	updateStatus(message) {
		this.state.lastAction = message;
		const status = this.buildStatus(message);
		this.safeSendMessage(status);
		chrome.storage.local.set({ raidStatus: status });
	}

	safeSendMessage(message) {
		return new Promise((resolve) => {
			try {
				chrome.runtime.sendMessage(message, (response) => {
					if (chrome.runtime.lastError) {
						const err = chrome.runtime.lastError.message || '';
						if (!err.includes('Receiving end does not exist')) {
							console.warn('Message Send Error:', err);
						}
					}
					resolve(response);
				});
			} catch {
				resolve();
			}
		});
	}

	// ==========================================================
	// Utilities
	// ==========================================================

	getBreakTimeLeft() {
		return this.breakManager?.state?.isOnBreak && this.breakManager.state.breakEndTime
			? Math.max(0, this.breakManager.state.breakEndTime - Date.now())
			: 0;
	}

	getRandomDelay(min, max) {
		return min + Math.random() * (max - min);
	}

	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

// ==========================================================
// Initialize
// ==========================================================

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => { window.raidAutomator = new RaidAutomator(); });
} else {
	window.raidAutomator = new RaidAutomator();
}