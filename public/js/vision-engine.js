/**
 * MedScan Vision & AI Multimodal Clinical Engine
 * Supports Gemini Vision API integration + Smart Heuristic Clinical OCR Engine
 */

class MedScanVisionEngine {
  constructor() {
    this.apiKey = localStorage.getItem('medscan_gemini_api_key') || '';
    this.selectedModel = localStorage.getItem('medscan_model') || 'gemini-1.5-flash';
    this.ocrWorkerPromise = null;
  }

  setApiKey(key) {
    this.apiKey = key.trim();
    localStorage.setItem('medscan_gemini_api_key', this.apiKey);
  }

  getApiKey() {
    return this.apiKey;
  }

  setModel(model) {
    this.selectedModel = model;
    localStorage.setItem('medscan_model', model);
  }

  /**
   * Main scan function: Accepts an image data URL (base64) and scan mode
   * mode: 'auto' | 'medicine' | 'prescription'
   */
  async analyzeImage(imageDataUrl, mode = 'auto', patientProfile = null) {
    if (this.apiKey) {
      try {
        const geminiResult = await this.callGeminiVision(imageDataUrl, mode);
        return this.enrichResultWithSafety(geminiResult, patientProfile);
      } catch (err) {
        console.warn('Gemini API call failed; trying on-device medicine recognition:', err);
      }
    }

    const result = await this.analyzeLocally(imageDataUrl, mode);
    return this.enrichResultWithSafety(result, patientProfile);
  }

  async analyzeLocally(imageDataUrl, mode) {
    const sampleId = this.detectSampleTag(imageDataUrl);
    if (sampleId) {
      const sampleResult = this.heuristicClinicalScan(imageDataUrl, mode);
      sampleResult.aiSource = 'Built-in Clinical Knowledge Engine';
      return sampleResult;
    }

    if (mode === 'prescription') {
      throw new Error('Reading prescription photos requires a Gemini Vision API key. Medicine package photos can be identified on this device without a key.');
    }

    const qrCodeText = await this.readQrCode(imageDataUrl);
    const detectedText = await this.recognizeMedicineText(imageDataUrl);
    const response = await fetch('/api/medicine-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [qrCodeText, detectedText].filter(Boolean).join('\n') })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `Medicine dataset search failed (${response.status}).`);
    }

    let drugInfo = null;
    try {
      const infoResponse = await fetch('/api/drug-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ composition: result.medicine.composition })
      });
      if (!infoResponse.ok) {
        throw new Error(`Drug-label lookup failed (${infoResponse.status}).`);
      }
      drugInfo = await infoResponse.json();
    } catch (error) {
      console.warn('External drug-label lookup failed:', error);
      drugInfo = { error: 'External drug-label information is currently unavailable.' };
    }

    const builtInMedicine = this.findBuiltInMedicine(result.medicine);
    const medicine = {
      ...result.medicine,
      genericName: builtInMedicine?.genericName || result.medicine.composition,
      dosageForm: builtInMedicine?.dosageForm || result.medicine.packSize,
      category: builtInMedicine?.category || result.medicine.category,
      indications: builtInMedicine?.indications || [],
      expiryDate: this.extractExpiryDate(detectedText, qrCodeText),
      datasetRecord: true,
      drugInfo
    };
    if (qrCodeText) {
      medicine.qrCodeText = qrCodeText;
    }

    return {
      type: 'medicine',
      confidence: result.confidence,
      detectedText,
      aiSource: 'On-device OCR + Indian Medicine Dataset',
      medicine
    };
  }

  async readQrCode(imageDataUrl) {
    if (!window.ZXingBrowser || !window.ZXing) return '';

    const image = new Image();
    image.src = imageDataUrl;
    await image.decode();

    const hints = new Map();
    hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      window.ZXing.BarcodeFormat.QR_CODE,
      window.ZXing.BarcodeFormat.DATA_MATRIX
    ]);
    const reader = new window.ZXingBrowser.BrowserMultiFormatReader(hints);
    try {
      const code = await reader.decodeFromImageElement(image);
      return code.getText();
    } catch (error) {
      if (error.name === 'NotFoundException' || error.name === 'ChecksumException' || error.name === 'FormatException') {
        return '';
      }
      throw error;
    } finally {
      reader.reset();
    }
  }

  async recognizeMedicineText(imageDataUrl) {
    if (!window.Tesseract) {
      throw new Error('On-device OCR did not load. Restart the app after installing dependencies, then try again.');
    }

    if (!this.ocrWorkerPromise) {
      this.ocrWorkerPromise = window.Tesseract.createWorker('eng', 1, {
        workerPath: '/vendor/tesseract/worker.min.js',
        corePath: '/vendor/tesseract-core',
        langPath: '/vendor/tessdata',
        gzip: true
      });
    }

    try {
      const worker = await this.ocrWorkerPromise;
      const { data } = await worker.recognize(imageDataUrl);
      if (!data.text.trim()) {
        throw new Error('No readable medicine name was found. Try a clear photo of the printed label or blister pack.');
      }
      return data.text;
    } catch (error) {
      this.ocrWorkerPromise = null;
      throw error;
    }
  }

  findBuiltInMedicine(datasetMedicine) {
    const datasetName = datasetMedicine.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const datasetComposition = datasetMedicine.composition.toLowerCase();
    return MEDICINE_DATABASE.find(medicine => {
      const searchableNames = [medicine.name, ...(medicine.brandNames || [])]
        .map(name => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
      return searchableNames.some(name => name && (datasetName.includes(name) || name.includes(datasetName))) ||
        (medicine.genericName && datasetComposition.includes(medicine.genericName.toLowerCase()));
    });
  }

  extractExpiryDate(...packageTexts) {
    const text = packageTexts.filter(Boolean).join('\n');
    const expiryMatch = text.match(/\b(?:exp(?:iry)?|use\s*before|use\s*by)(?:\s*(?:date|dt))?\s*[:.]?\s*(\d{1,2}\s*[/-]\s*\d{2,4}|\d{4}\s*[/-]\s*\d{1,2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4})/i);
    if (expiryMatch) {
      const date = expiryMatch[1].replace(/\s+/g, '');
      const numericDate = date.match(/^(\d{1,2})[/-](\d{2,4})$/);
      if (numericDate) {
        const month = Number(numericDate[1]);
        if (month >= 1 && month <= 12) {
          const year = numericDate[2].length === 2 ? `20${numericDate[2]}` : numericDate[2];
          return `${numericDate[1].padStart(2, '0')}/${year}`;
        }
      }

      const yearFirstDate = date.match(/^(\d{4})[/-](\d{1,2})$/);
      if (yearFirstDate) {
        const month = Number(yearFirstDate[2]);
        if (month >= 1 && month <= 12) {
          return `${yearFirstDate[2].padStart(2, '0')}/${yearFirstDate[1]}`;
        }
      }

      const monthNameDate = date.match(/^([a-z]+)(\d{4})$/i);
      if (monthNameDate) return `${monthNameDate[1]} ${monthNameDate[2]}`;
    }

    const gs1Expiry = packageTexts[1]?.match(/(?:\(\s*17\s*\)|17)(\d{6})/);
    if (gs1Expiry) {
      const [, year, month] = gs1Expiry[1].match(/^(\d{2})(\d{2})\d{2}$/) || [];
      if (year && Number(month) >= 1 && Number(month) <= 12) {
        return `${month}/20${year}`;
      }
    }
    return '';
  }

  /**
   * Calls Google Gemini Multimodal Vision API directly
   */
  async callGeminiVision(imageDataUrl, mode) {
    const base64Data = imageDataUrl.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');
    const mimeMatch = imageDataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    const systemInstruction = `You are MedScan AI, an expert clinical pharmacist and prescription reader assistant.
Analyze this image (which could be a medicine strip, bottle, tablet, or doctor prescription).
Respond ONLY with a valid, raw JSON object (NO markdown backticks, NO \`\`\`json wrappers).
The JSON MUST follow this exact schema:
{
  "type": "medicine" or "prescription",
  "confidence": 0.95,
  "detectedText": "all readable text from image",
  "medicine": {
    "name": "Primary medicine name",
    "genericName": "Active salt/molecule",
    "brandNames": ["Brand1", "Brand2"],
    "strength": "e.g. 500 mg",
    "category": "Therapeutic class",
    "dosageForm": "Tablet/Capsule/Syrup/Inhaler",
    "indications": ["Primary use 1", "Use 2"],
    "howToTake": "Clear patient instructions on when and how to take",
    "dosageGuidelines": {
      "adults": "Adult dosage",
      "pediatric": "Pediatric precautions"
    },
    "sideEffects": {
      "common": ["Side effect 1", "Side effect 2"],
      "serious": ["Serious symptom 1", "Serious symptom 2"]
    },
    "contraindications": ["Contraindication 1", "Contraindication 2"],
    "foodInteractions": ["Food/alcohol advisory"],
    "drugInteractions": [
      { "drug": "Interacting drug", "severity": "High/Moderate", "risk": "Description of risk" }
    ],
    "storage": "Storage instructions",
    "genericAlternatives": [
      { "name": "Generic name", "approxPriceFactor": "X% cheaper" }
    ],
    "allergyWarningFamily": "e.g. Penicillin, NSAID, Sulfa, etc."
  },
  "prescription": {
    "doctorName": "Dr. Name if visible or unknown",
    "patientName": "Patient name if visible",
    "date": "Prescription date if visible",
    "diagnosis": "Diagnosed condition / symptoms",
    "medications": [
      {
        "name": "Medicine name",
        "dosage": "500 mg",
        "frequency": "1-0-1 (Twice daily after food)",
        "duration": "5 days",
        "instructions": "Specific instruction"
      }
    ],
    "doctorNotes": "General advice or follow-up date"
  }
}`;

    const promptText = mode === 'prescription' 
      ? 'Read this doctor prescription. Transcribe the medications, dosages, frequency (e.g. 1-0-1, OD, BD), duration, diagnosis, and doctor instructions.'
      : 'Analyze this medicine packaging / strip / pill. Identify the active ingredients, dosage, usage, side effects, precautions, interactions, and generic substitutes.';

    const requestBody = {
      contents: [
        {
          parts: [
            { text: systemInstruction + '\n\n' + promptText },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Data
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048
      }
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.selectedModel}:generateContent?key=${this.apiKey}`;
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      throw new Error(errJson.error?.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) {
      throw new Error('No analysis text generated by Gemini.');
    }

    // Clean JSON response (strip markdown wrappers if model included them)
    let cleanedJson = candidate.trim();
    if (cleanedJson.startsWith('```json')) {
      cleanedJson = cleanedJson.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (cleanedJson.startsWith('```')) {
      cleanedJson = cleanedJson.replace(/^```/, '').replace(/```$/, '').trim();
    }

    const parsed = JSON.parse(cleanedJson);
    parsed.aiSource = `Gemini Vision AI (${this.selectedModel})`;
    return parsed;
  }

  /**
   * Smart Clinical Heuristic Engine
   * Matches images against medicine knowledge base or prescription patterns
   */
  heuristicClinicalScan(imageDataUrl, mode) {
    // If the image contains a sample identifier tag stored in the image or metadata
    const sampleId = this.detectSampleTag(imageDataUrl);

    if (mode === 'prescription' || sampleId === 'sample-rx') {
      return this.generateSamplePrescription();
    }

    let matchedMed = null;
    if (sampleId && sampleId !== 'sample-rx') {
      matchedMed = MEDICINE_DATABASE.find(m => m.id === sampleId);
    }

    if (!matchedMed) {
      throw new Error('Unable to identify this medicine image locally. Add a Gemini Vision API key in AI Vision Settings or choose a demo preset. No medicine details were inferred.');
    }

    return {
      type: "medicine",
      confidence: 0.96,
      detectedText: `${matchedMed.name} ${matchedMed.strength} - ${matchedMed.genericName}. Batch: ${matchedMed.batchNo || 'MFD2026'} EXP: ${matchedMed.expiryDate || '12/2028'}`,
      medicine: {
        ...matchedMed
      }
    };
  }

  detectSampleTag(dataUrl) {
    // Check if the data url has metadata embedded or is from our sample gallery
    if (dataUrl.includes('sample:amoxicillin')) return 'amoxicillin-500';
    if (dataUrl.includes('sample:paracetamol')) return 'paracetamol-650';
    if (dataUrl.includes('sample:metformin')) return 'metformin-500';
    if (dataUrl.includes('sample:amlodipine')) return 'amlodipine-5';
    if (dataUrl.includes('sample:rx')) return 'sample-rx';
    return null;
  }

  generateSamplePrescription() {
    return {
      type: "prescription",
      confidence: 0.92,
      detectedText: "Dr. Robert Vance, MD (Internal Medicine) - Rx: 1. Amoxicillin 500mg (1-0-1 x 5d), 2. Paracetamol 650mg (SOS for fever), 3. Pantoprazole 40mg (1-0-0 empty stomach x 5d). Diagnosis: Acute Bronchitis.",
      prescription: {
        doctorName: "Dr. Robert Vance, MD",
        clinic: "St. Jude Metropolitan Health Clinic",
        patientName: "Active Patient Profile",
        date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
        diagnosis: "Acute Bronchitis & Upper Respiratory Infection with Pyrexia",
        medications: [
          {
            name: "Amoxicillin Capsules",
            dosage: "500 mg",
            frequency: "1-0-1 (Twice Daily after meals)",
            duration: "5 Days",
            instructions: "Complete the full course; do not stop early.",
            purpose: "Antibacterial coverage for bronchial infection"
          },
          {
            name: "Paracetamol Tablets",
            dosage: "650 mg",
            frequency: "SOS (As needed, max 3 times/day)",
            duration: "3-5 Days",
            instructions: "Take only if body temperature exceeds 100°F (37.8°C) or for headache/body aches.",
            purpose: "Antipyretic and analgesic"
          },
          {
            name: "Pantoprazole Gastro-Resistant",
            dosage: "40 mg",
            frequency: "1-0-0 (Once daily in the morning)",
            duration: "5 Days",
            instructions: "Take 30-45 minutes before breakfast with a glass of water.",
            purpose: "Gastric acid suppression & mucosal protection"
          }
        ],
        doctorNotes: "Rest adequately. Drink 2.5-3 liters of warm fluids daily. Return for review in 5 days if cough or fever persists."
      }
    };
  }

  /**
   * Evaluates compatibility against patient allergies and medical conditions
   */
  enrichResultWithSafety(result, patient) {
    if (!patient) return result;

    const safetyAlerts = [];
    const allergies = patient.allergies || [];
    const conditions = patient.conditions || [];

    // Helper to evaluate a medicine
    const checkSafety = (medName, generic, allergyFamily, contraindications = []) => {
      const issues = [];
      const medLower = (medName + ' ' + (generic || '') + ' ' + (allergyFamily || '')).toLowerCase();

      // Allergy check
      allergies.forEach(allergy => {
        const allLower = allergy.toLowerCase();
        if (allLower.includes('penicillin') && (medLower.includes('amoxicillin') || medLower.includes('penicillin') || medLower.includes('ampicillin'))) {
          issues.push({
            severity: 'DANGER',
            title: `Critical Allergy Alert: ${allergy}`,
            message: `Patient has documented allergy to ${allergy}. This medication belongs to the Penicillin family and carries high risk of severe anaphylaxis!`
          });
        } else if (allLower.includes('nsaid') && (medLower.includes('ibuprofen') || medLower.includes('aspirin') || medLower.includes('naproxen') || medLower.includes('diclofenac'))) {
          issues.push({
            severity: 'DANGER',
            title: `Critical Allergy Alert: ${allergy}`,
            message: `Patient is allergic to NSAIDs. Avoid this drug to prevent bronchospasm or severe reaction.`
          });
        } else if (allLower.includes('sulfa') && medLower.includes('sulfa')) {
          issues.push({
            severity: 'DANGER',
            title: `Allergy Alert: ${allergy}`,
            message: `Contains sulfonamide component which may trigger hypersensitivity.`
          });
        }
      });

      // Condition check
      conditions.forEach(cond => {
        const condLower = cond.toLowerCase();
        if (condLower.includes('pregnancy')) {
          if (medLower.includes('atorvastatin') || medLower.includes('statin')) {
            issues.push({
              severity: 'DANGER',
              title: 'Pregnancy Warning: Category X',
              message: 'Statins are strictly contraindicated during pregnancy due to fetal risk.'
            });
          } else if (medLower.includes('ibuprofen') || medLower.includes('nsaid')) {
            issues.push({
              severity: 'WARNING',
              title: 'Pregnancy Precaution: NSAID',
              message: 'Avoid NSAIDs especially in 3rd trimester (risk of premature closure of ductus arteriosus).'
            });
          }
        }

        if (condLower.includes('kidney') || condLower.includes('renal')) {
          if (medLower.includes('metformin')) {
            issues.push({
              severity: 'WARNING',
              title: 'Renal Function Alert',
              message: 'Metformin requires strict monitoring of renal filtration (eGFR). Contraindicated in severe impairment.'
            });
          } else if (medLower.includes('ibuprofen') || medLower.includes('nsaid')) {
            issues.push({
              severity: 'DANGER',
              title: 'Renal Risk Alert',
              message: 'NSAIDs reduce renal prostaglandin synthesis and can induce acute kidney injury in renal patients.'
            });
          }
        }

        if (condLower.includes('asthma')) {
          if (medLower.includes('aspirin') || medLower.includes('ibuprofen')) {
            issues.push({
              severity: 'WARNING',
              title: 'Asthma Caution',
              message: 'May trigger bronchospasm in patients with aspirin-sensitive asthma.'
            });
          }
        }

        if (condLower.includes('liver') || condLower.includes('hepatic')) {
          if (medLower.includes('paracetamol') || medLower.includes('acetaminophen')) {
            issues.push({
              severity: 'WARNING',
              title: 'Hepatic Dosage Limit',
              message: 'Patient has liver condition. Keep total daily paracetamol dosage strictly under 2,000 mg.'
            });
          }
        }
      });

      return issues;
    };

    if (result.type === 'medicine' && result.medicine) {
      const med = result.medicine;
      const issues = checkSafety(med.name, med.genericName, med.allergyWarningFamily, med.contraindications);
      safetyAlerts.push(...issues);
    } else if (result.type === 'prescription' && result.prescription?.medications) {
      result.prescription.medications.forEach(rxMed => {
        const issues = checkSafety(rxMed.name, rxMed.name, '', []);
        safetyAlerts.push(...issues);
      });
    }

    result.safetyAlerts = safetyAlerts;
    result.patientProfile = {
      name: patient.name,
      age: patient.age,
      allergies: patient.allergies,
      conditions: patient.conditions
    };

    return result;
  }
}

// Global instance
window.visionEngine = new MedScanVisionEngine();
