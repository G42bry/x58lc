'use strict';

const can = require('socketcan');

module.exports = function initDragConfig(ctx) {
  const CONFIG = {
    canInterface: 'can0',
    brakeCanId: 0x19F,       // G42 M240i SP18 Brake Pressure & Pedal Frame
    steeringCanId: 0x1D6,    // Steering Wheel Cruise Buttons (RES / CANCEL)
    releaseMask: 0x04        // Cruise CANCEL/RES button drops spoof & launches
  };

  let state = {
    lcArmed: false,
    drivetrain: 'xDrive AWD',
    statusText: 'Disarmed — Ready (Set DSC OFF & Sport+)',
    alive: 0
  };

  let spoofTimer = null;
  const channel = can.createRawChannel(CONFIG.canInterface, true);
  channel.start();

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
    state.statusText = 'G42 Drivetrain Faults Cleared';
    ctx.redraw();
  }

  // Arm 4700 RPM Launch Control Bypass (Spoofs 0x19F Brake Pressure on Line Lock)
  async function setLaunchBypass(arm) {
    if (arm) {
      await clearDrivetrainFaults();
      spoofTimer = setInterval(() => {
        state.alive = (state.alive + 1) & 0x0F;
        const frame = Buffer.alloc(8, 0x00);

        frame = 0xF0 | state.alive;  // Byte 1: Brake switch pressed + alive counter
        frame = 0x55;                // Byte 2: Spoofed ~85 bar hydraulic brake pressure
        frame = 0x04;                // Byte 3: Valid brake pressure plausibility flag
        frame = calcBmwCrc8(frame);  // Byte 0: Valid BMW CRC-8 checksum

        channel.send({ id: CONFIG.brakeCanId, data: frame });
      }, 10);

      state.lcArmed = true;
      state.statusText = 'ARMED — 4700 RPM LC Ready (Hit Steering Btn to Launch)';
    } else {
      if (spoofTimer) clearInterval(spoofTimer);
      spoofTimer = null;
      state.lcArmed = false;
      state.statusText = 'OEM — Launch Released';
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

  // Instant Release when Cruise CANCEL/RES button is pressed
  channel.addListener('onMessage', (msg) => {
    if (state.lcArmed && msg.id === CONFIG.steeringCanId) {
      if ((msg.data & CONFIG.releaseMask) !== 0) {
        setLaunchBypass(false);
      }
    }
  });

  // Handle native BMW HMI button clicks
  ctx.onAction((action) => {
    if (action === 'armLaunch') setLaunchBypass(true);
    if (action === 'disarmLaunch') setLaunchBypass(false);
    if (action === 'clearFaults') clearDrivetrainFaults();
    if (action === 'setRwd') setRwdMode(true);
    if (action === 'setAwd') setRwdMode(false);
  });

  // Render Engine Config-style status card onto mgu-renderd canvas
  ctx.onDraw((g) => {
    g.drawStatusHeader({
      title: state.lcArmed ? '4700 RPM LC ARMED' : 'G42 STANDBY',
      subtitle: state.statusText,
      badge: state.drivetrain,
      accent: state.lcArmed ? 'm_red' : 'm_blue'
    });
  });
};

