/**
 * `kf_rf_soll` as the CSL 0401 community partial ships it — the Alpha-N reference table.
 *
 * 24 rows (opening) x 20 columns (rpm), the app's own `AXIS_LOAD` / `AXIS_RPM`, values as the
 * binary stores them once decoded (uint16 / 1000). Z lives at `0xD356`.
 *
 * **It is a reference, and this was checked rather than assumed**: all 480 cells are bit-identical
 * to `0xD356` in `public/mock/csl-0401-community-patch-v1.partial.bin`. The RETIRED note further
 * down used to claim the opposite — "not any particular car's stock map once a campaign has run,
 * the tuner in question had already moved 364 of its 480 cells" — and that was reading the wrong
 * side of a comparison. 363 cells differ between this table and `scripts/fixtures/session-920-base.bin`,
 * which is the difference between the REFERENCE and that CAR. The car moved; the reference did not.
 *
 * That is what makes RESTORE VE possible: a table to go back TO has to come from bytes, and this
 * does. See `BinaryPatcher.restoreVeTable`.
 */
export const CSL_STOCK_MAP_DATA: number[][] = [
    [0.210, 0.152, 0.113, 0.095, 0.092, 0.088, 0.075, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050],
    [0.242, 0.163, 0.132, 0.126, 0.105, 0.084, 0.085, 0.074, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050],
    [0.283, 0.186, 0.147, 0.134, 0.118, 0.104, 0.090, 0.079, 0.077, 0.077, 0.063, 0.063, 0.063, 0.063, 0.063, 0.063, 0.063, 0.063, 0.063, 0.063],
    [0.331, 0.262, 0.209, 0.192, 0.178, 0.156, 0.140, 0.133, 0.124, 0.116, 0.108, 0.103, 0.095, 0.087, 0.080, 0.079, 0.073, 0.073, 0.073, 0.073],
    [0.445, 0.349, 0.300, 0.263, 0.262, 0.246, 0.228, 0.204, 0.198, 0.189, 0.171, 0.153, 0.138, 0.110, 0.103, 0.085, 0.079, 0.079, 0.079, 0.079],
    [0.496, 0.433, 0.401, 0.337, 0.321, 0.293, 0.274, 0.252, 0.238, 0.227, 0.208, 0.190, 0.179, 0.145, 0.125, 0.107, 0.095, 0.095, 0.089, 0.089],
    [0.538, 0.474, 0.443, 0.368, 0.355, 0.326, 0.313, 0.280, 0.273, 0.254, 0.230, 0.218, 0.204, 0.173, 0.140, 0.117, 0.111, 0.105, 0.099, 0.099],
    [0.550, 0.491, 0.468, 0.385, 0.364, 0.335, 0.322, 0.285, 0.281, 0.262, 0.239, 0.227, 0.213, 0.176, 0.149, 0.121, 0.115, 0.109, 0.103, 0.103],
    [0.565, 0.504, 0.481, 0.400, 0.386, 0.348, 0.329, 0.287, 0.284, 0.276, 0.259, 0.246, 0.224, 0.180, 0.166, 0.133, 0.127, 0.121, 0.121, 0.121],
    [0.578, 0.531, 0.496, 0.444, 0.418, 0.366, 0.368, 0.354, 0.343, 0.333, 0.306, 0.287, 0.262, 0.241, 0.212, 0.189, 0.162, 0.155, 0.155, 0.155],
    [0.588, 0.577, 0.556, 0.528, 0.494, 0.462, 0.444, 0.430, 0.425, 0.400, 0.380, 0.333, 0.305, 0.281, 0.240, 0.228, 0.174, 0.174, 0.174, 0.174],
    [0.615, 0.685, 0.723, 0.618, 0.594, 0.539, 0.552, 0.511, 0.500, 0.479, 0.449, 0.420, 0.398, 0.358, 0.313, 0.296, 0.250, 0.241, 0.215, 0.215],
    [0.645, 0.708, 0.749, 0.661, 0.625, 0.582, 0.614, 0.602, 0.590, 0.556, 0.534, 0.518, 0.500, 0.439, 0.389, 0.381, 0.346, 0.317, 0.312, 0.275],
    [0.681, 0.755, 0.804, 0.706, 0.668, 0.664, 0.726, 0.719, 0.672, 0.647, 0.645, 0.602, 0.599, 0.534, 0.464, 0.465, 0.430, 0.402, 0.381, 0.362],
    [0.727, 0.824, 0.819, 0.694, 0.667, 0.702, 0.794, 0.790, 0.765, 0.750, 0.714, 0.727, 0.699, 0.609, 0.567, 0.579, 0.503, 0.478, 0.461, 0.446],
    [0.770, 0.899, 0.817, 0.687, 0.667, 0.739, 0.831, 0.835, 0.796, 0.774, 0.751, 0.792, 0.790, 0.679, 0.632, 0.650, 0.566, 0.528, 0.522, 0.477],
    [0.893, 0.968, 0.829, 0.680, 0.667, 0.769, 0.917, 0.871, 0.822, 0.805, 0.886, 0.901, 0.902, 0.786, 0.746, 0.758, 0.675, 0.629, 0.605, 0.557],
    [1.006, 0.994, 0.834, 0.666, 0.667, 0.774, 0.964, 0.857, 0.825, 0.838, 0.925, 0.941, 0.955, 0.865, 0.842, 0.839, 0.754, 0.703, 0.677, 0.629],
    [1.078, 1.053, 0.842, 0.656, 0.669, 0.816, 0.981, 0.847, 0.831, 0.845, 0.948, 0.952, 0.964, 0.920, 0.898, 0.891, 0.804, 0.755, 0.726, 0.692],
    [1.121, 1.070, 0.846, 0.649, 0.669, 0.862, 0.989, 0.861, 0.834, 0.851, 0.955, 0.961, 0.970, 0.976, 0.954, 0.933, 0.848, 0.805, 0.777, 0.743],
    [1.156, 1.092, 0.807, 0.664, 0.728, 0.894, 0.991, 0.865, 0.845, 0.861, 0.972, 0.987, 0.981, 1.053, 1.041, 1.019, 0.955, 0.921, 0.904, 0.870],
    [1.181, 1.124, 0.825, 0.664, 0.753, 0.914, 1.025, 0.896, 0.863, 0.867, 1.017, 1.001, 0.994, 1.118, 1.089, 1.073, 1.044, 1.012, 1.009, 0.969],
    [1.186, 1.145, 0.841, 0.666, 0.769, 0.941, 1.038, 0.930, 0.878, 0.868, 1.032, 1.024, 1.032, 1.144, 1.108, 1.096, 1.078, 1.057, 1.063, 1.011],
    [1.202, 1.167, 0.845, 0.670, 0.784, 0.954, 1.042, 0.932, 0.879, 0.868, 1.037, 1.027, 1.037, 1.157, 1.113, 1.101, 1.087, 1.060, 1.071, 1.017]
];

export const APP_CONFIG = {
    MSS54HP: {
        // Binary Map Addresses (Partial Read)
        // NOTE: These addresses need to be verified against the user's specific binary version.
        // Using placeholders or likely defaults based on user input.
        ADDRESS_MAP_CONFIG: 0xE5E4, // k_rf_cfg
        ADDRESS_TEMP_LIMIT: 0x4824, // K_LAA_TMOT_MIN
        // The other end of the same window. `laa_st_calc` (slave 0x019B90) needs
        // MIN < TMOT < MAX to enable EITHER long-term learner, so the PATCH's MIN = 100 degC
        // against this 100 degC leaves no temperature at which anything can learn. Reading both
        // is what lets `trimNeutrality` say "frozen" from the bytes instead of from a toggle.
        ADDRESS_TEMP_LIMIT_MAX: 0x4825, // K_LAA_TMOT_MAX
        /** Both are stored as `x - 48` degC. */
        TEMP_LIMIT_OFFSET_C: 48,

        VE_TABLE: {
            ADDRESS_X_AXIS: 0xD2FE, // RPM Axis
            ADDRESS_Y_AXIS: 0xD326, // Load Axis
            ADDRESS_DATA: 0xD356,   // VE Data
            SIZE_X: 20,
            SIZE_Y: 24,
        },

        // Fixed Axis Points as defined by user
        AXIS_RPM: [
            600, 870, 1100, 1300, 1400, 1600, 1800, 2100, 2200, 2400,
            2700, 2900, 3100, 3900, 4600, 5300, 6300, 6900, 7300, 7900
        ],
        AXIS_LOAD: [
            0.10, 0.15, 0.20, 0.40, 0.60, 0.80, 1.00, 1.10, 1.20, 1.40,
            1.60, 2.40, 3.20, 5.00, 7.50, 10.00, 15.00, 20.00, 25.00, 30.00,
            45.00, 65.00, 85.00, 100.00
        ],

        // Interpolation Table for Relative Throttle Correction
        INTERPOLATION_TABLE: [
            { rpm: 0, factor: 0.7 },
            { rpm: 900, factor: 0.7 },
            { rpm: 1100, factor: 0.7 },
            { rpm: 1300, factor: 0.75 },
            { rpm: 1400, factor: 0.8 },
            { rpm: 1600, factor: 0.85 },
            { rpm: 1800, factor: 0.9 },
            { rpm: 2100, factor: 0.95 },
            { rpm: 2400, factor: 1.0 },
            { rpm: 3000, factor: 1.0 },
            { rpm: 3900, factor: 1.0 },
            { rpm: 7000, factor: 1.0 },
            { rpm: 8000, factor: 1.0 },
            { rpm: 10000, factor: 1.0 },
        ]
    },

    CSV_MAPPING: {
        TIME: 'time',
        RPM: 'RPM',
        RAW_LOAD: 'relativer Oeffnungsquerschnitt', // German header
        STFT_1: 'Lambdaintegrator 1',
        STFT_2: 'Lambdaintegrator 2', // Attempt to match if exists
        LAMBDA_1: 'Lambda 1', // [NEW]
        LAMBDA_2: 'Lambda 2', // [NEW]
        COOLANT_TEMP: 'Kuehlmitteltemperatur', // Guessing/Safety, or fallback
        // User only provided Lambdaintegrator 1, so we handle missing 2 in code.
        // Header names the WRITER uses live above; the READER accepts any of CSV_ALIASES below.
        EXHAUST_TEMP: 'Abgastemperatur',
        RF: 'relative Fuellung',
        // Tank ventilation. German, matching the rest of this table — the DME's own vocabulary is
        // Tankentlueftung, and a log exported here should re-import through the same names.
        TANK_VENT: 'Tankentlueftung Ventil',
        TANK_VENT_CHECK: 'Tankentlueftung Funktionspruefung',
        TANK_VENT_DIAG: 'Tankentlueftung Diagnose',
        // Throttle position, and the lambda freeze byte. Same rule as the three above: a channel the
        // live link produces has to survive the CSV round trip or downloading a run silently loses it.
        WDK1: 'Drosselklappe Istwert',
        LAMBDA_FREEZE: 'Lambda Freeze Flag',
        INTAKE_TEMP: 'Intake Air Temp',
        CHARGE_TEMP: 'Charge Temp Modelled',
        AMBIENT_PRESSURE: 'Ambient Pressure',
        ALTITUDE: 'Altitude',
        AMBIENT_PRESSURE_SUBSTITUTED: 'Ambient Pressure Substituted',
        AMBIENT_TEMP: 'Outside Air Temp',
        AMBIENT_TEMP_SUBSTITUTED: 'Outside Air Temp Substituted',
        VEHICLE_SPEED: 'Road Speed',
        LTFT_1: 'Lambda LT 1',
        LTFT_2: 'Lambda LT 2',
        LLS_ST: 'Idle Valve Status',
        MD_DYN_ST: 'Slew Limiter State',
        MD_FW: 'Torque Request',
        MD_FW_FILTER: 'Torque Request Filtered',
        MD_LS_DELTA: 'Tip-in Allowance',
        MD_DP_DELTA: 'Dashpot Allowance',
        PRESSURE_DECODE_GAP: 'Pressure Decode Gap',
        // Testo's own headers for the six angles ("Ignition angle cyl. n" on 12050B13), so a log
        // exported here reads as the same channel in either tool.
        IGNITION_ANGLE_1: 'Ignition angle cyl. 1',
        IGNITION_ANGLE_2: 'Ignition angle cyl. 2',
        IGNITION_ANGLE_3: 'Ignition angle cyl. 3',
        IGNITION_ANGLE_4: 'Ignition angle cyl. 4',
        IGNITION_ANGLE_5: 'Ignition angle cyl. 5',
        IGNITION_ANGLE_6: 'Ignition angle cyl. 6',
        KNOCK_AGE_1: 'Knock Age 1',
        KNOCK_AGE_2: 'Knock Age 2',
        KNOCK_AGE_3: 'Knock Age 3',
        KNOCK_AGE_4: 'Knock Age 4',
        KNOCK_AGE_5: 'Knock Age 5',
        KNOCK_AGE_6: 'Knock Age 6',
    },

    /**
     * Header names the log READER will accept, lowercased, first match wins.
     *
     * ### ADD A NEWLY-DISCOVERED CSV HEADER NAME HERE — nowhere else.
     *
     * The parser used to carry one header per field plus an ad-hoc `temp1/temp2/temp3` chain for
     * coolant, which is why coolant was the only field that tolerated a second spelling. Those
     * three spellings are reproduced verbatim below, so behaviour is unchanged for every log that
     * parsed before this table existed.
     *
     * `rf` and `exhaustTemp` are the two channels the EGT correction work depends on, and they are
     * NOT equally optional:
     *
     *   rf           REQUIRED. parseLogFile throws without it — see the comment there. Over DS2 it
     *                arrives in the same 35-byte response as rpm and load, so a live run always
     *                has it; a CSV that lacks it needs the column added, not a second derivation.
     *   exhaustTemp  Optional. Without it the DME-table route for rf_korr cannot index a Δ, which
     *                the app states and works around by using RF ÷ rf_soll.
     *
     * Both are seeded with the names this app's own serializer writes, so an exported log
     * re-imports. Real Testo header names still have to be read off the car — add them here.
     */
    CSV_ALIASES: {
        // The TODO below is discharged. These are no longer guesses: they are Testo's own MSS54
        // channel list, `ecudata/MSS54DS0_DATATABLE_results.txt`, which gives every channel as
        // `display name, SYMBOL, unit, telegram` — and the display name is what a Testo CSV heads
        // its column with. The telegram field settles provenance too: `12050B03` is DS2 selection 3
        // and `12050B13` is selection 19, the same two blocks this app reads.
        //
        // The list is a German/English mix, which is why guessing did not work. `Abgastemperatur`,
        // `Tankentlueftung Ventil` and `Drosselklappe Istwert` were all reasonable and all wrong;
        // Testo says `Exhaust temp.`, `Tank ventilation valve duty cycle`, `Throttle pos. actual`.
        // The invented spellings stay, LAST, because this app's own serializer writes them and an
        // exported log has to re-import.
        time: ['time', 'zeit'],
        rpm: ['rpm', 'drehzahl'],
        rawLoad: ['relativer oeffnungsquerschnitt'],
        stft1: ['lambdaintegrator 1'],
        stft2: ['lambdaintegrator 2'],
        /**
         * ORDER MATTERS HERE, and it is not cosmetic — first match wins.
         *
         * Testo exports TWO temperatures from block 3 and only one of them is the engine:
         *   Motor temp.   MOTORTEMPERATUR          = tmot, the DME's engine temperature
         *   Coolant temp. KUEHLW_AUSL_TEMPERATUR   = tka, the RADIATOR OUTLET
         *
         * `tmot` is what the minimum-temperature filter tests and what the DME's own warm-up logic
         * uses; the radiator outlet is a different sensor that reads lower and lags. A CSV carrying
         * both would have matched `coolant temp` first under the old ordering and quietly filtered
         * the log against the wrong one, so the correct spellings are now ahead of it.
         */
        coolantTemp: ['motor temp.', 'motortemperatur', 'kuehlmitteltemperatur', 'coolant temp.', 'coolant temp'],
        // Testo's name first, this app's serializer second — see the note at the top of the table.
        rf: ['relative fuellung'] as string[],
        exhaustTemp: ['exhaust temp.', 'abgastemperatur'] as string[],
        tankVent: ['tank ventilation valve duty cycle', 'tankentlueftung ventil'] as string[],
        wdk1: ['throttle pos. actual', 'drosselklappe istwert'] as string[],
        // No Testo equivalent: these three are not in its MSS54 list at all, so the serializer's own
        // header is the only name they have. `tefc_ll_st` and `tefc_ed` are decoded here from bytes
        // Testo never surfaced, and `la_freeze_flag` is not even named outside karter16's catalog.
        tankVentCheckState: ['tankentlueftung funktionspruefung'] as string[],
        tankVentDiag: ['tankentlueftung diagnose'] as string[],
        lambdaFreeze: ['lambda freeze flag'] as string[],
        // Testo has no column for this — it is a RAM read on the slow lane, not a block field — so
        // the app's own spelling is the only one that exists. See the intakeTemp field entry.
        intakeTemp: ['intake air temp', 'ansauglufttemperatur'] as string[],
        // Same situation as intakeTemp: RAM reads on the slow lane, so the app's own spelling
        // is the only one they have. The German forms are the DME's own symbols, accepted so a
        // log exported by another MSS54 tool still reads.
        chargeTemp: ['charge temp modelled', 'tan_m'] as string[],
        ambientPressure: ['ambient pressure', 'umgebungsdruck', 'p_umg'] as string[],
        altitude: ['altitude', 'hoehe', 'p_umg_hoehe'] as string[],
        ambientPressureSubstituted: ['ambient pressure substituted'] as string[],
        ambientTemp: ['outside air temp', 'aussentemperatur', 't_umg'] as string[],
        ambientTempSubstituted: ['outside air temp substituted'] as string[],
        vehicleSpeed: ['road speed', 'geschwindigkeit', 'v'] as string[],
        ltft1: ['lambda lt 1', 'laa_f1', 'ltft1'] as string[],
        ltft2: ['lambda lt 2', 'laa_f2', 'ltft2'] as string[],
        llsSt: ['idle valve status', 'lls_st', 'lls st'] as string[],
        mdDynSt: ['slew limiter state', 'md_dyn_st', 'md dyn st'] as string[],
        mdFw: ['torque request', 'md_fw'] as string[],
        mdFwFilter: ['torque request filtered', 'md_fw_filter'] as string[],
        mdLsDelta: ['tip-in allowance', 'md_ls_delta'] as string[],
        mdDpDelta: ['dashpot allowance', 'md_dp_delta'] as string[],
        pressureDecodeGap: ['pressure decode gap'] as string[],
        // Testo's list names these (`Ignition angle cyl. n`, symbol TZn, telegram 12050B13), so for
        // once the first spelling is read off Testo rather than this app's serializer — they are
        // the same string. The reference catalog's lowercase symbol is accepted as well.
        ignitionAngle1: ['ignition angle cyl. 1', 'tz1'] as string[],
        ignitionAngle2: ['ignition angle cyl. 2', 'tz2'] as string[],
        ignitionAngle3: ['ignition angle cyl. 3', 'tz3'] as string[],
        ignitionAngle4: ['ignition angle cyl. 4', 'tz4'] as string[],
        ignitionAngle5: ['ignition angle cyl. 5', 'tz5'] as string[],
        ignitionAngle6: ['ignition angle cyl. 6', 'tz6'] as string[],
        // A RAM counter with no DME symbol, so this app's header is the only name it has.
        knockAge1: ['knock age 1'] as string[],
        knockAge2: ['knock age 2'] as string[],
        knockAge3: ['knock age 3'] as string[],
        knockAge4: ['knock age 4'] as string[],
        knockAge5: ['knock age 5'] as string[],
        knockAge6: ['knock age 6'] as string[],
    },

    /**
     * Below this median, a log's RF column is read as a FRACTION and multiplied by 100.
     *
     * The DS2 channel is a percentage (80.0 means 80 % filling) and `annotateRfKorr` divides by
     * 100 to compare it against the dimensionless Alpha-N table. A CSV exporter may equally well
     * write 0.80. Both conventions are plausible and the difference is a factor of 100, which is
     * not a subtle wrongness — it makes every measured rf_korr absurd. 3 sits far from both
     * populations: a real percentage under load is 55–110, a real fraction is 0.55–1.10.
     *
     * Same shape of decision as `medianStep` in log-engine/filter.ts, which tells a seconds log
     * from a milliseconds one; median rather than mean for the same reason, and the threshold sits
     * in the wide empty gap between the two populations rather than near either.
     */
    CSV_RF_FRACTION_THRESHOLD: 3,

    CSV_DELIMITER: ';', // Explicitly set for this format

    CONSTANTS: {
        TEMP_THRESHOLD: 80, // Engine Temp > 80°C
        TARGET_TEMP_VAL: 148, // 100°C in raw value (x - 48) -> 148 - 48 = 100
        STOCK_TEMP_VAL: 0, // 0 in raw value (x - 48) -> 0 - 48 = -48°C (Always Adapt)
    }
};

export const MAP_DIMENSIONS = {
    rows: 24,
    cols: 20
};

export const RPM_AXIS = APP_CONFIG.MSS54HP.AXIS_RPM;
export const TPS_AXIS = APP_CONFIG.MSS54HP.AXIS_LOAD;

/**
 * `kf_rf_soll_kath` as the CSL 0401 community partial ships it — the CATALYST-WARMUP Alpha-N table.
 *
 * A different table from `kf_rf_soll` with different axes, which is the whole reason it needs its
 * own reference: X runs 600-4600 rpm (`0xD718`) against the main table's 600-7900, and Y (`0xD740`)
 * has no 0.146 % row. Never match the two up by row number — `kf_rf_soll` row 3 is y 0.391 and
 * kath row 3 is y 0.610.
 *
 * These were transcribed from screenshots and are no longer placeholders: the stock table decoded
 * from the XDF matches this one in all 480 cells, and so does `0xD770` in the shipped community
 * partial. Address and uint16 x/1000 scaling are confirmed with it. See
 * `BinaryPatcher.restoreWarmupTable`.
 */
export const CSL_STOCK_WARMUP_RPM = [
    600, 900, 1000, 1100, 1300, 1400, 1600, 1800, 2000, 2200,
    2400, 2700, 2900, 3000, 3100, 3400, 3600, 3900, 4200, 4600
];

export const CSL_STOCK_WARMUP_LOAD = [
    0.10, 0.20, 0.39, 0.61, 0.81, 1.00, 1.10, 1.20, 1.39, 1.61,
    2.00, 2.39, 2.81, 3.20, 5.00, 7.50, 10.01, 14.99, 20.00, 25.00,
    30.00, 45.00, 64.99, 85.01
];

// Warmup Map (Cold Start) - 20x24 - Transcribed from Screenshot
export const CSL_STOCK_WARMUP_MAP: number[][] = [
    [0.221, 0.181, 0.156, 0.145, 0.102, 0.096, 0.093, 0.088, 0.050, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000],
    [0.273, 0.217, 0.190, 0.184, 0.153, 0.141, 0.130, 0.117, 0.104, 0.095, 0.083, 0.083, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050, 0.050],
    [0.351, 0.277, 0.240, 0.233, 0.208, 0.194, 0.184, 0.160, 0.151, 0.142, 0.140, 0.129, 0.119, 0.116, 0.113, 0.112, 0.111, 0.111, 0.095, 0.095],
    [0.447, 0.360, 0.325, 0.333, 0.294, 0.279, 0.257, 0.238, 0.208, 0.201, 0.205, 0.189, 0.144, 0.141, 0.140, 0.135, 0.122, 0.139, 0.105, 0.105],
    [0.488, 0.418, 0.412, 0.401, 0.348, 0.328, 0.292, 0.289, 0.265, 0.242, 0.230, 0.207, 0.188, 0.180, 0.174, 0.161, 0.152, 0.161, 0.115, 0.115],
    [0.510, 0.458, 0.455, 0.461, 0.410, 0.366, 0.328, 0.306, 0.282, 0.268, 0.250, 0.230, 0.211, 0.200, 0.194, 0.180, 0.170, 0.173, 0.143, 0.128],
    [0.521, 0.478, 0.480, 0.475, 0.415, 0.378, 0.339, 0.331, 0.290, 0.278, 0.261, 0.244, 0.219, 0.209, 0.202, 0.189, 0.180, 0.182, 0.150, 0.140],
    [0.525, 0.497, 0.502, 0.508, 0.450, 0.399, 0.367, 0.340, 0.295, 0.287, 0.273, 0.263, 0.234, 0.224, 0.225, 0.202, 0.193, 0.191, 0.167, 0.150],
    [0.533, 0.558, 0.544, 0.548, 0.495, 0.445, 0.408, 0.387, 0.360, 0.353, 0.357, 0.328, 0.289, 0.279, 0.274, 0.261, 0.250, 0.245, 0.219, 0.203],
    [0.549, 0.587, 0.599, 0.585, 0.563, 0.505, 0.471, 0.463, 0.435, 0.436, 0.439, 0.373, 0.346, 0.331, 0.331, 0.313, 0.303, 0.290, 0.268, 0.247],
    [0.638, 0.677, 0.665, 0.648, 0.574, 0.528, 0.515, 0.485, 0.464, 0.459, 0.460, 0.401, 0.375, 0.369, 0.378, 0.357, 0.343, 0.329, 0.301, 0.280],
    [0.652, 0.703, 0.686, 0.672, 0.595, 0.543, 0.524, 0.526, 0.500, 0.484, 0.483, 0.448, 0.422, 0.414, 0.420, 0.405, 0.388, 0.369, 0.335, 0.317],
    [0.660, 0.721, 0.720, 0.698, 0.623, 0.568, 0.563, 0.576, 0.525, 0.526, 0.525, 0.502, 0.466, 0.463, 0.469, 0.462, 0.438, 0.417, 0.381, 0.357],
    [0.666, 0.736, 0.744, 0.722, 0.643, 0.612, 0.604, 0.624, 0.578, 0.596, 0.608, 0.593, 0.520, 0.519, 0.546, 0.505, 0.478, 0.465, 0.422, 0.393],
    [0.673, 0.767, 0.784, 0.769, 0.677, 0.669, 0.702, 0.745, 0.697, 0.648, 0.677, 0.654, 0.630, 0.628, 0.623, 0.594, 0.575, 0.547, 0.508, 0.485],
    [0.675, 0.789, 0.814, 0.798, 0.702, 0.674, 0.733, 0.801, 0.787, 0.767, 0.768, 0.783, 0.775, 0.741, 0.750, 0.712, 0.685, 0.630, 0.607, 0.590],
    [0.704, 0.895, 0.845, 0.801, 0.702, 0.676, 0.783, 0.843, 0.825, 0.774, 0.777, 0.872, 0.857, 0.845, 0.840, 0.775, 0.740, 0.693, 0.671, 0.659],
    [0.756, 0.951, 0.901, 0.822, 0.704, 0.678, 0.787, 0.872, 0.830, 0.775, 0.836, 0.949, 0.983, 0.923, 0.928, 0.862, 0.829, 0.791, 0.783, 0.774],
    [0.817, 0.999, 0.911, 0.829, 0.693, 0.684, 0.793, 0.898, 0.832, 0.815, 0.866, 0.953, 0.984, 0.963, 0.975, 0.921, 0.898, 0.863, 0.866, 0.871],
    [0.922, 1.024, 0.929, 0.833, 0.683, 0.683, 0.814, 0.905, 0.831, 0.825, 0.874, 0.965, 0.997, 0.971, 0.986, 0.948, 0.934, 0.920, 0.923, 0.925],
    [0.975, 1.037, 0.935, 0.838, 0.669, 0.694, 0.821, 0.907, 0.832, 0.834, 0.884, 0.982, 1.026, 0.986, 0.995, 0.976, 0.973, 0.976, 0.976, 0.977],
    [0.999, 1.063, 0.939, 0.801, 0.666, 0.756, 0.856, 0.909, 0.826, 0.837, 0.911, 1.040, 1.051, 1.018, 1.031, 1.037, 1.037, 1.055, 1.060, 1.065],
    [1.028, 1.081, 0.941, 0.810, 0.664, 0.770, 0.866, 0.910, 0.827, 0.840, 0.943, 1.071, 1.083, 1.027, 1.050, 1.073, 1.087, 1.118, 1.115, 1.112],
    [1.038, 1.093, 0.946, 0.811, 0.661, 0.772, 0.874, 0.913, 0.832, 0.844, 0.953, 1.110, 1.106, 1.078, 1.101, 1.106, 1.115, 1.143, 1.139, 1.135]
];

// WOT Map Axes (Derived from Screenshots)
/**
 * RETIRED — `KF_TI_N_RF_VL`'s axes and Z, transcribed from a screenshot.
 *
 * They fed `generateWOTMap`, which is gone (see COMMUNITY_WOT_FUEL_RAW). The reason not to bring
 * them back as they were: the Z row disagreed with the shipped community partial in one count
 * (1.062 against 1.063 at 1200 rpm). A reference table has to come from bytes, which is what
 * COMMUNITY_WOT_FUEL_RAW is.
 *
 * This note used to carry a second reason — that `CSL_STOCK_MAP_DATA` was itself not stock. It is
 * stock, and the check is written out above it. Retired with the rest.
 */

/**
 * `KF_TI_N_RF_VL` as the community patch ships it — the full-load injection-time multiplier.
 *
 * Raw bytes, `x/128`, 18 rpm points (700 900 1000 1200 1300 1400 1700 1900 2100 2300 2600 3000
 * 3300 3500 4400 5800 6400 8000). All three RF rows (0.8 / 0.9 / 1.0) hold this same row, so the
 * table is effectively one-dimensional in rpm.
 *
 * ## What it does, and why a reference copy is worth shipping
 *
 * At full load `ti_load_factor` (slave `0x01c6ca`) selects this table instead of `KF_TI_N_RF`, and
 * the result multiplies the injection time. `KF_TI_N_RF` is 1.000 across its whole part-load range,
 * which is the proof that these are MULTIPLIERS and not fuel tables: a table of ones cannot be an
 * amount. So the mixture at full load is `lambda = 1 / (rf_korr x this)` — the numbers below imply
 * lambda 0.77 to 1.05, which is BMW's full-load enrichment.
 *
 * **The VE table must not be compensated into this one.** Fuel is already proportional to
 * `rf_soll x rf_korr`, so correcting the VE table corrects the fuel; multiplying this table by the
 * same ratio applies the correction twice and the mixture goes lean by c^2. That is not
 * hypothetical — it is what `generateWOTMap` did, and a car came back with this table scaled by its
 * VE ratio and a full-load lambda of 1.23 at 2100 rpm. Nothing had gone wrong yet only because the
 * WOT-threshold patch was in, so the table was never reached.
 *
 * Shipped as a constant rather than read from `public/mock/…partial.bin` so the restore works with
 * no network and no mock asset, and so `verify:wot-reference` can assert the two agree.
 */
export const COMMUNITY_WOT_FUEL_RAW: readonly number[] = [
    122, 145, 138, 136, 156, 151, 148, 134, 140, 146, 164, 166, 152, 159, 155, 155, 156, 156,
];

/** Rows in `KF_TI_N_RF_VL`'s Z block. All identical — see COMMUNITY_WOT_FUEL_RAW. */
export const WOT_FUEL_ROWS = 3;

// [EXPERIMENTAL] Binary Addresses
export const EXPERIMENTAL_CONFIG = {
    ADDRESS_WARMUP_MAP: 0xD770,
    ADDRESS_WOT_MAP: 0xB5A,
    ADDRESS_WOT_THRESHOLD_MAP: 0xAC54 // KF_BZ_WDK_VL (4x4)
};

/**
 * The calibration that decides whether the lambda controller was running — Funktionsrahmen 5.01.
 *
 * Addresses from `CSL_0401_Karter16_v3_6_publish.xdf`, which orients a 64 KB partial as
 * [slave 0x0000-0x7FFF | master 0x8000-0xFFFF], so an XDF address is an offset. `KF_BZ_WDK_VL` is
 * master and the three lambda constants are slave, which is why they look like different worlds.
 *
 * `ADDRESS_WOT_THRESHOLD_MAP` above is the same table's Z data. It has been in the app since the WOT
 * patch shipped, but only ever as "is the first cell over 1000", because the axes were not known and
 * a patch check does not need them. Reading a threshold at an operating point does.
 */
export const LAMBDA_SHUTDOWN = {
    /** KF_BZ_WDK_VL — throttle % at which the DME calls it full load. Z is x/10. */
    WOT_THRESHOLD_X: 0xAC44,   // 4 x u16, rpm
    WOT_THRESHOLD_Y: 0xAC4C,   // 4 x u16, degC
    WOT_THRESHOLD_Z: 0xAC54,   // 4 rows x 4 cols u16, x/10 -> %
    /** KL_LA_N — relative filling above which the controller is switched off, over rpm. Y is
     *  x/1000. Measured 1.500 flat across all seven points on a real binary, i.e. unreachable
     *  (filling runs 0.3-1.1), so this gate is expected to report zero. Implemented anyway: it is
     *  a calibration and another car's may differ, and a gate that silently is not there is worse
     *  than one that honestly reports nothing. */
    LOAD_THRESHOLD_X: 0x489A,  // 7 x u16, rpm
    LOAD_THRESHOLD_Y: 0x48A8,  // 7 x u16, x/1000
    /** K_LA_FMAX / K_LA_FMIN — the controller's clamps, x/32768. Measured 1.30 / 0.70. */
    F_MAX: 0x481A,
    F_MIN: 0x481C,
} as const;

/**
 * `K_TE_TVTE_GA` — the tank-vent duty gain, slave `0xBF1`, one byte.
 *
 * Not in EXPERIMENTAL_CONFIG, because it is not experimental in the way those three are. Their
 * scaling is unverified (see docs/ecu-logic/60-tuning-logic.md §7); this one is confirmed twice
 * over — at instruction level in tetv_calc (slave 0x26ED6), and by karter16 logging the valve on a
 * real car. What it shares with them is being TUNING ONLY, which is a different property and is
 * enforced by the toggle rather than by where the constant lives.
 *
 * Stock is 0x80 = 1.0 with the XDF's x/128 conversion. Zero holds the valve shut.
 *
 * It is HALF of TANK VENT. The other half is `TANK_VENT_TMOT` below: this byte shuts the valve,
 * that one stops the purge adaptation the valve being shut does not stop.
 */
export const TANK_VENT_GAIN = {
    ADDRESS: 0xBF1,
    STOCK_RAW: 0x80,
    DISABLED_RAW: 0x00,
} as const;

/**
 * `K_TE_TMOT` — the coolant temperature above which the tank-vent state machine purges, slave
 * `0x0BED`, one byte, °C = raw − 48. The second half of TANK VENT (2026-10-18).
 *
 * What the DME does with it — `FUN_000263DA` (slave 0x0263DA), the tank-vent state machine:
 *
 *     TMOT > K_TE_TMOT  ->  purge phase, and in it the purge adaptation TEA learns:
 *         TEA_REGLER1  = 1 s low-pass of LA_F_REGLER1                (the bank-1 lambda trim)
 *         TEA1_F      += TEA_REGLER1's moves away from 1.0,
 *                        clamped to [KF_TEA_FMIN_N_RF 0.75, K_TEA_FMAX 1.04]
 *         TEA1_F_KORR  = 1 + (TEA1_F − 1) × TEA_F_SETZ,  TEA_F_SETZ = KF_TEA_FSETZ_N_RF(N, RF)
 *     otherwise         ->  no purge; TEA takes its forget branch and TEA1_F_KORR stays 1.000
 *
 *     TI_F_ADAPT = LA_F_REGLER × LAA_F × TEA_F_KORR                   (slave 0x01DC16-0x01DC36)
 *
 * TEA1_F_KORR multiplies the injection time beside the trim, so whatever TEA has learned is lambda
 * error the trim no longer shows. It is slave-only RAM (0xFFE812) and no block this app logs carries
 * it: the logged STFT the VE write reads is short by that factor, and nothing in the log says so.
 *
 * Why `TANK_VENT_GAIN` alone does not stop it: K_TE_TVTE_GA's only reader is `tetv_calc` (slave
 * 0x026ED6), which makes the valve DUTY. This state machine never reads it — with the valve shut it
 * still enters purge above 69 °C, and TEA still learns, now from a trim that holds no vapour at all.
 *
 * How much it can hide. KF_TEA_FSETZ_N_RF is 0.55-0.83 at RF 0.3-0.4 and 0.05 at RF >= 0.54, so
 * with TEA1_F at a clamp:
 *
 *     RF 0.17-0.46 (the low-load VE rows)   (0.75 − 1) × 0.83 = −21 %    (1.04 − 1) × 0.83 = +3.3 %
 *     RF >= 0.54                            (0.75 − 1) × 0.05 = −1.25 %  (1.04 − 1) × 0.05 = +0.2 %
 *
 * The patch: 0xFF = 207 °C, a coolant temperature no engine reaches. The only reader is
 * `FUN_000263DA` — eight compares, at slave 0x0265E6, 0x026670, 0x02676C, 0x026818, 0x0268FE,
 * 0x0269CA, 0x026B82 and 0x026C06 — so the state machine never enters purge, TEA takes its forget
 * branch every pass, and TEA1_F_KORR stays at the 1.000 it starts from (TEA1_F = 1.0 at power-up,
 * `FUN_00026E4C`). The cost is the tank-vent functional check, and its OBD readiness, which never
 * runs: TUNING ONLY like the valve byte, written and restored by the same toggle
 * (`BinaryPatcher.setTankVentDisable`).
 *
 * Stock 0x75 = 69 °C, read at offset 0x0BED of the car's BIN and of
 * `public/mock/csl-0401-community-patch-v1.partial.bin`. The 64 KB partial puts slave at
 * 0x0000-0x7FFF, so the slave address is the offset, and the slave checksum the byte sits under is
 * corrected by the same `applyChecksumCorrection` every other patch byte relies on.
 */
export const TANK_VENT_TMOT = {
    ADDRESS: 0x0BED,
    STOCK_RAW: 0x75,
    DISABLED_RAW: 0xFF,
} as const;

/**
 * `kl_rf_korr_rf_min` — the filling floor, per rpm, above which `rf_korr` may engage at all.
 *
 * Master, 6 x u16 at `0xE90C`, `x/1000`; the rpm breakpoints sit at `0xE900` and are NOT touched.
 * Verified against session #946's BASE: x = 1400/1600/2000/2500/3300/4000 rpm,
 * y = 700/550/650/650/650/800 raw, i.e. 0.70/0.55/0.65/0.65/0.65/0.80 RF.
 *
 * What the DME does with it — `rf_korr`, master 0x021A70, re-evaluated every background pass:
 *
 *     rf_soll >  floor(N)         && V >  k_rf_korr_v_min  ->  rf_korr = KF_RF_KORR_DRREL(N, Δ)
 *     rf_soll >= floor(N) - 0.100 && V >= k_rf_korr_v_min  ->  rf_korr held
 *     otherwise                                            ->  rf_korr = 1.000
 *     RF = rf_soll · rf_korr >> 10,   Δ = max(0, kf_rf_tabg_modell(N, RF) − TABG)
 *
 * Every reader was found by whole-binary scan: this curve is read only by `rf_korr`, and `rf_korr`
 * only by `rf_calc`. So the floor is a pure lever on whether the DRREL step reaches RF at all.
 *
 * ## K HOLD — the measurement patch, `HELD_RAW` in all six points
 *
 * With the floor unreachable the gate never opens, and the DME uses 1.000 everywhere, which is the
 * table's Δ=30 row: K ≡ 1. The VE log needs that because of how the lambda loop answers a K step.
 * Its rich-side I slope is fixed (`KF_LA_KI_NEG` 13 raw = 0.0406/s at 2200-2700 rpm, RF >= 0.5;
 * logged median −0.040/s), so after the gate opens the trim reads ≈ 1 − 0.0406·t whatever the VE
 * error is, and `trim × K` reports elapsed time rather than VE. Written back, it lifts the band
 * +5.5..8.4 % per pass with no fixed point. With K ≡ 1 the trim alone carries the VE error, and
 * DIRECT converges (error ×0.55-0.65 per pass).
 *
 * Why 2000 (2.000 RF):
 *
 *   - The entry compare is unsigned, so rf_soll would have to exceed 2.000, and the hold branch
 *     needs 2.000 − `k_rf_korr_hys` = 1.900. `kf_rf_soll` peaks near 1.2, so neither is reachable.
 *   - 0xFFFF is the obvious "never", but `readEgtTables`' plausibility check refuses a floor above
 *     2.0, and then the whole EGT set reads null — the app would lose the gate it replays drives with.
 *   - Held is detected by EXACT equality of all six words (`getRfKorrGateFloorHeld`), never by a
 *     threshold: a synthetic test image or a hand-raised floor at 1.5 is not this patch.
 *
 * `rf_korr_st` has one reader, the slave's LAA enable, and PATCH already empties that window
 * (`K_LAA_TMOT_MIN` = 100 °C). Without PATCH, LAA would learn this band's error — which is why the
 * hub offers K HOLD only with PATCH armed.
 *
 * What it costs while it is in the car: no cold-exhaust enrichment at all, and because RF no longer
 * carries rf_korr, up to 2.3° more ignition advance at 2400-3000 rpm part load. TUNING ONLY; every
 * restore (PATCH OFF, FINALIZE) puts `STOCK_RAW` back — see `BinaryPatcher.setRfKorrGateFloor`.
 *
 * ## The retired drop
 *
 * `DROPPED_RAW` was the RF GATE toggle: a 0.400 floor to make Δ ≤ 30 samples reachable as an anchor
 * for DRREL. The anchor is now the converged VE itself, so the toggle is gone and nothing writes a
 * drop into an image that leaves the app. The two constants stay so a BIN still carrying it is
 * recognised, and so a log recorded against it replays through the floor the DME was running.
 */
export const RF_KORR_GATE_FLOOR = {
    /** The Y block. The X block at 0xE900 is deliberately absent: the breakpoints stay BMW's. */
    VALUES_ADDRESS: 0xE90C,
    POINTS: 6,
    /** 2.000 RF — K HOLD. Unreachable by rf_soll on entry and on hold; see the doc above. */
    HELD_RAW: 2000,
    /** 0.400 RF — the retired RF GATE drop. Recognised and restored, never written by a build. */
    DROPPED_RAW: 400,
    /**
     * A floor at or below this counts as "this app dropped it", for the same reason
     * `setWOTThreshold` tests `> 1000`: a restore has to know whether the loaded bytes are a
     * measurement to go back to or this patch looking at itself. BMW's lowest point is 0.55, so
     * anything at 0.45 or under is not a calibration this car shipped with.
     */
    DROPPED_MAX_RAW: 450,
    /** Where a restore lands when the loaded BASE was ALREADY held or dropped and so cannot say
     *  what it held before. Read off session #946's BASE, not transcribed from a document. */
    STOCK_RAW: [700, 550, 650, 650, 650, 800],
} as const;

/**
 * `KF_RF_KORR_DRREL` (master, X 0xE84A, Y 0xE862, Z 0xE86E, `x/1024`) as BMW ships it in 0401 —
 * the 純正 the RF KORR tuner's 300/400 shrink is a fraction of.
 *
 *     s          = (new(top) − 1) / (STOCK(top) − 1)       top: the highest row this log measured
 *     new(r>top) = 1 + s · (STOCK(r) − 1)                  stepped from the LOADED value, −0.05/log
 *
 * Against BMW's table, not the loaded one, because the loaded one is this app's own work from the
 * second DRREL pass on. Taken against the loaded table the ratio is pass-relative: once the top row
 * stops moving s reads 1, and once it reaches 1.000 the column has no excess to divide by, so rows
 * the step limit had held back froze part-way (stock 1.25/1.32/1.37 at Δ 200/300/400 with D = 1.0
 * measured each pass: 300/400 stuck at 1.070/1.120 from the fifth pass, against 1.000 by the
 * formula). The loaded table is still where each step starts from.
 *
 * Read off the shipped partial (`public/mock`), whose DRREL the community patch does not touch;
 * `verify:rf-korr-tuner` pins the two equal. A table on other axes is another calibration, and the
 * tuner shrinks it against its own loaded values instead.
 */
export const CSL_STOCK_RF_KORR_DRREL = {
    RPM: [1100, 1200, 1400, 1600, 1900, 2200, 2350, 3000, 3200, 4000, 5000, 5100],
    DELTA: [30, 40, 100, 200, 300, 400],
    RAW: [
        [1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024],
        [1024, 1044, 1044, 1044, 1044, 1043, 1043, 1043, 1043, 1044, 1044, 1024],
        [1024, 1044, 1052, 1059, 1059, 1070, 1094, 1070, 1070, 1067, 1044, 1024],
        [1024, 1075, 1069, 1030, 1042, 1166, 1189, 1126, 1102, 1078, 1075, 1024],
        [1024, 1075, 1075, 1046, 1062, 1284, 1308, 1204, 1123, 1094, 1075, 1024],
        [1024, 1075, 1075, 1070, 1094, 1357, 1404, 1260, 1139, 1102, 1075, 1024],
    ],
} as const;

// Stock WOT Threshold Map (4x4) - Transcribed
// Scaling: x/10 (Raw = Val * 10)
export const CSL_STOCK_WOT_THRESHOLD_MAP: number[][] = [
    [35.00, 55.00, 63.00, 65.00],
    [35.00, 55.00, 63.00, 65.00],
    [35.00, 55.00, 63.00, 65.00],
    [35.00, 55.00, 63.00, 65.00]
];
