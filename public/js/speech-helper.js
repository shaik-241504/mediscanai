/**
 * Speech Helper (Text-to-Speech) and Web Audio Synthesizer
 * Features:
 * - Natural text-to-speech announcement for tablets & medicines
 * - Play, Pause, Resume, Stop controls
 * - Speech rate & pitch adjustment
 * - Voice selector
 * - Web Audio feedback sound effects (shutter, chime)
 */

class SpeechHelper {
  constructor() {
    this.synth = window.speechSynthesis;
    this.currentUtterance = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.audioCtx = null;
    this.voices = [];
    this.selectedVoice = null;
    this.currentText = '';

    if (this.synth) {
      this.loadVoices();
      if (this.synth.onvoiceschanged !== undefined) {
        this.synth.onvoiceschanged = () => this.loadVoices();
      }
    }
  }

  loadVoices() {
    if (!this.synth) return;
    this.voices = this.synth.getVoices();
    // Prefer clear English voices (Google US English, Samantha, Microsoft Zira/David)
    this.selectedVoice = this.voices.find(v => 
      (v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Samantha') || v.name.includes('Jenny') || v.name.includes('Zira')))
    ) || this.voices.find(v => v.lang.startsWith('en')) || this.voices[0] || null;
  }

  speak(text, options = {}) {
    if (!this.synth) {
      console.warn('Speech synthesis not supported in this browser.');
      return;
    }

    this.stop();

    if (!text || text.trim() === '') return;
    this.currentText = text;

    this.currentUtterance = new SpeechSynthesisUtterance(text);
    this.currentUtterance.lang = options.lang || 'en-US';
    this.currentUtterance.rate = options.rate !== undefined ? options.rate : 0.95; // Slightly slower for clinical clarity
    this.currentUtterance.pitch = options.pitch !== undefined ? options.pitch : 1.0;

    const language = options.lang || 'en-US';
    const languageCode = language.split('-')[0].toLowerCase();
    const matchingVoice = this.voices.find(voice => voice.lang.toLowerCase() === language.toLowerCase()) ||
      (language.toLowerCase() !== 'en-in'
        ? this.voices.find(voice => voice.lang.toLowerCase().startsWith(`${languageCode}-`))
        : null);
    if (options.voice) {
      this.currentUtterance.voice = options.voice;
    } else if (matchingVoice) {
      this.currentUtterance.voice = matchingVoice;
    } else if (languageCode === 'en' && this.selectedVoice) {
      this.currentUtterance.voice = this.selectedVoice;
    }

    this.currentUtterance.onstart = () => {
      this.isPlaying = true;
      this.isPaused = false;
      this.triggerEvent('start');
    };

    this.currentUtterance.onpause = () => {
      this.isPlaying = true;
      this.isPaused = true;
      this.triggerEvent('pause');
    };

    this.currentUtterance.onresume = () => {
      this.isPlaying = true;
      this.isPaused = false;
      this.triggerEvent('resume');
    };

    this.currentUtterance.onend = () => {
      this.isPlaying = false;
      this.isPaused = false;
      this.triggerEvent('end');
    };

    this.currentUtterance.onerror = (e) => {
      console.error('Speech synthesis error:', e);
      this.isPlaying = false;
      this.isPaused = false;
      this.triggerEvent('error', { error: e.error });
      this.triggerEvent('end');
    };

    this.synth.speak(this.currentUtterance);
  }

  pause() {
    if (this.synth && this.isPlaying && !this.isPaused) {
      this.synth.pause();
      this.isPaused = true;
      this.triggerEvent('pause');
    }
  }

  resume() {
    if (this.synth && this.isPaused) {
      this.synth.resume();
      this.isPaused = false;
      this.triggerEvent('resume');
    }
  }

  stop() {
    if (this.synth) {
      this.synth.cancel();
      this.isPlaying = false;
      this.isPaused = false;
      this.triggerEvent('end');
    }
  }

  toggleSpeech(text, options = {}) {
    if (this.isPlaying) {
      if (this.isPaused) {
        this.resume();
      } else {
        this.stop();
      }
    } else {
      this.speak(text, options);
    }
  }

  triggerEvent(name, detail = {}) {
    const event = new CustomEvent('speech_' + name, { detail: { helper: this, ...detail } });
    window.dispatchEvent(event);
  }

  // Camera shutter and scan success audio effects via Web Audio API (zero external sound file dependencies)
  initAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    }
  }

  playShutterSound() {
    try {
      this.initAudioContext();
      if (!this.audioCtx) return;
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(800, this.audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, this.audioCtx.currentTime + 0.08);

      gain.gain.setValueAtTime(0.3, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.08);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.09);
    } catch (e) {
      // Audio autoplay policy catch
    }
  }

  playSuccessChime() {
    try {
      this.initAudioContext();
      if (!this.audioCtx) return;
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 chord
      notes.forEach((freq, idx) => {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.15, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.26);
      });
    } catch (e) {
      // Audio autoplay policy catch
    }
  }
}

window.speechHelper = new SpeechHelper();
