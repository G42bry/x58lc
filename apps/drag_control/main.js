'use strict';

const can = require('socketcan');

module.exports = function initDragConfig(ctx) {
  // ==========================================================================
  // G42 M240i (700+ HP PTE 6470 / ZF 8HP51) — TOGGLEABLE AUTO-CUTOFF
  // ==========================================================================
  const CONFIG = {
    canInterface: 'can0',
    brakeCanId: 0x19F,          // G42 SP18 Brake Pressure & Pedal Frame
    boostCanId: 0x3F9,          // DME Manifold Boost Pressure Frame
    rpmCanId: 0x0F3,            // Engine RPM Frame
    atfTempCanId: 0x39A,        // ZF8 Transmission Fluid Temp Frame

    maxSpoolHoldMs: 2500,       // Max 2.5s hold when Auto-Cutoff is ON
    minAtfTempC: 45,            // Block launch below 113°F (45°C) ATF
    maxAtfTempC: 105,           // Block launch above 221°F (105°C) ATF
    pedalPressedThreshold: 0x15 // Minimum real pedal pressure (~20 bar) to stay armed
  };

  let state = {
    lcArmed: false,
    autoCutoff: true,           // Default ON (10 PSI / 2.5s safety cutoff)
    maxLaunchPsi: 10.0,
    drivetrain: 'xDrive AWD',
    statusText: 'Standby — Auto-Cutoff ON (10 PSI Max)',
    alive: 0,
    pedalWasPressed: false,
    spoolStartTime: null,
    atfTempC: 75
  };

  let spoofTimer = null;
  const channel = can.createRawChannel(CONFIG.canInterface, true);
  channel.start();

  // Sync with iDrive Settings menu changes
  function syncSettings() {
    const mode = ctx.settings.get('autoCutoffEnabled');
    const psiStr = ctx.settings.get('boostCutoffPsi') || '10 PSI';
    state.autoCutoff = (mode !== 'OFF (Manual Release Only)');
    state.maxLaunchPsi = parseFloat(psiStr) || 10.0;
  }

  // BMW E2E Profile 1 CRC-8 Checksum
  function calcBmwCrc8(buf) {
    let crc = 0xFF;
    for (let i = 1; i < buf.length; i++) {
      crc ^= buf[i];
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x80) ? ((crc << 1) ^ 0x1D) : (crc << 1);
        crc &= 0xFF;
      }
    }
    return crc ^ 0xFF;
  }

  // Clear DSC (0x29), VIP (0x39), EGS/xHP (0x18), and VTG (0x19) faults
  async function clearDrivetrainFaults() {
    for (const ecu of [0x29, 0x39, 0x18, 0x19]) {
      await ctx.diag.physical(ecu, [0x14, 0xFF, 0xFF, 0xFF]).catch(() => {});
    }
    state.statusText = 'Drivetrain Faults Cleared';
    ctx.redraw();
  }

  // Arm Launch Control Bypass
  async function setLaunchBypass(arm) {
    if (arm) {
      if (state.autoCutoff && (state.atfTempC < CONFIG.minAtfTempC || state.atfTempC > CONFIG.maxAtfTempC)) {
        state.statusText = `BLOCKED: Trans Temp ${state.atfTempC}°C (Safe: 45–105°C)`;
        ctx.redraw();
        return;
      }

      await clearDrivetrainFaults();
      state.pedalWasPressed = false;
      state.spoolStartTime = null;

      spoofTimer = setInterval(() => {
        state.alive = (state.alive + 1) & 0x0F;
        const frame = Buffer.alloc(8, 0x00);

        frame = 0xF0 | state.alive;  // Brake switch active + alive counter
        frame = 0x55;                // Spoofed ~85 bar pressure (bypasses 2500 RPM cap)
        frame = 0x04;                // Valid pressure plausibility flag
        frame = calcBmwCrc8(frame);  // Valid BMW CRC-8 checksum

        channel.send({ id: CONFIG.brakeCanId, data: frame });

        // Enforce 2.5s heat timer ONLY when Auto-Cutoff is ON
        if (state.autoCutoff && state.spoolStartTime && (Date.now() - state.spoolStartTime > CONFIG.maxSpoolHoldMs)) {
          setLaunchBypass(false);
          state.statusText = 'Safety Disarm: 2.5s Converter Heat Limit';
          ctx.redraw();
        }
      }, 10);

      state.lcArmed = true;
      state.statusText = state.autoCutoff
        ? `ARMED — Auto-Cutoff ON (${state.maxLaunchPsi} PSI / 2.5s)`
        : 'ARMED — Auto-Cutoff OFF (Lift Brake Foot to Launch)';
    } else {
      if (spoofTimer) clearInterval(spoofTimer);
      spoofTimer = null;
      state.lcArmed = false;
      state.pedalWasPressed = false;
      state.spoolStartTime = null;
      state.statusText = state.autoCutoff
        ? `Released — Auto-Cutoff ON (${state.maxLaunchPsi} PSI)`
        : 'Released — Auto-Cutoff OFF (Manual)';
    }
    ctx.redraw();
  }

  // G42 M240i xDrive / RWD Toggle via VIP (0x39) & DSC (0x29)
  async function setRwdMode(enableRwd) {
    await ctx.diag.physical(0x39, [0x10, 0x03]).catch(() => {});
    await ctx.diag.physical(0x29, [0x10, 0x03]).catch(() => {});

    if (enableRwd) {
      await ctx.diag.physical(0x39, [0x2E, 0xDB, 0x2F, 0x00]).catch(() => {});
      await ctx.diag.physical(0x29, [0x2E, 0xDB, 0xE1, 0x00]).catch(() => {});
      state.drivetrain = 'RWD (Burnout)';
      state.statusText = 'xDrive OFF — Rear-Wheel Drive Active';
    } else {
      await ctx.diag.physical(0x39, [0x2E, 0xDB, 0x2F, 0x01]).catch(() => {});
      await ctx.diag.physical(0x29, [0x2E, 0xDB, 0xE1, 0x01]).catch(() => {});
      await clearDrivetrainFaults();
      state.drivetrain = 'xDrive AWD';
      state.statusText = 'xDrive ON — AWD Ready for Launch';
    }
    ctx.redraw();
  }

  // PT-CAN Telemetry & Release Listeners
  channel.addListener('onMessage', (msg) => {
    if (msg.id === CONFIG.atfTempCanId && msg.data.length >= 2) {
      state.atfTempC = msg.data - 40;
    }

    if (!state.lcArmed) return;

    // 1) Always release immediately when physical brake foot lifts
    if (msg.id === CONFIG.brakeCanId && msg.data !== 0x55) {
      const realPressure = msg.data;
      if (realPressure >= CONFIG.pedalPressedThreshold) {
        state.pedalWasPressed = true;
      } else if (state.pedalWasPressed && realPressure < 0x08) {
        setLaunchBypass(false);
      }
    }

    // 2) Auto-Cutoff checks (only active when Auto-Cutoff is ON)
    if (state.autoCutoff) {
      if (msg.id === CONFIG.rpmCanId && msg.data.length >= 4) {
        const rpm = ((msg.data << 8) | msg.data) * 0.25;
        if (rpm > 2600 && !state.spoolStartTime) {
          state.spoolStartTime = Date.now();
        }
      }

      if (msg.id === CONFIG.boostCanId && msg.data.length >= 2) {
        const boostPsi = (msg.data * 0.145) - 14.7;
        if (boostPsi >= state.maxLaunchPsi) {
          setLaunchBypass(false);
          state.statusText = `Auto-Cutoff Released at ${state.maxLaunchPsi} PSI`;
          ctx.redraw();
        }
      }
    }
  });

  // Handle native BMW HMI button clicks & settings updates
  ctx.onAction((action) => {
    if (action === 'armLaunch') setLaunchBypass(true);
    if (action === 'disarmLaunch') setLaunchBypass(false);
    if (action === 'clearFaults') clearDrivetrainFaults();
    if (action === 'setRwd') setRwdMode(true);
    if (action === 'setAwd') setRwdMode(false);
    if (action === 'toggleSafety') {
      state.autoCutoff = !state.autoCutoff;
      state.statusText = state.autoCutoff
        ? `Auto-Cutoff ON (${state.maxLaunchPsi} PSI / 2.5s Guard)`
        : 'Auto-Cutoff OFF (Manual Brake-Lift Release)';
      ctx.redraw();
    }
  });

  if (ctx.settings && ctx.settings.onChange) {
    ctx.settings.onChange(() => {
      syncSettings();
      ctx.redraw();
    });
  }

  // Render Engine Config-style status card onto mgu-renderd canvas
  ctx.onDraw((g) => {
    const cutoffBadge = state.autoCutoff ? `CUTOFF: ${state.maxLaunchPsi} PSI` : 'CUTOFF: OFF';
    g.drawStatusHeader({
      title: state.lcArmed ? `LC ARMED (${cutoffBadge})` : `G42 STANDBY (${state.atfTempC}°C ATF)`,
      subtitle: state.statusText,
      badge: `${state.drivetrain} | ${cutoffBadge}`,
      accent: state.lcArmed ? 'm_red' : 'm_blue'
    });
  });
};
