#!/usr/bin/env python3
"""
Speech-to-text worker.

Loading the model costs a couple of seconds and the first transcription after that
costs about thirty more, while CUDA picks its kernels. Paying that per voice message
would make the whole feature useless in the one place it matters — a phone in a car,
where the alternative is typing. So the model is loaded once and the process stays up,
reading one job per line and answering one line per job. Every message after the first
lands in under two seconds.

Protocol, one JSON object per line each way:
    in   {"id": "...", "path": "C:\\...\\clip.ogg", "lang": "he"}
    out  {"id": "...", "text": "..."}  |  {"id": "...", "error": "..."}
    out  {"ready": true, "device": "cuda", "model": "medium"}   once, at startup

Reads audio through ffmpeg, so whatever Telegram sends — ogg, m4a, mp3 — just works.
"""

import json
import os
import sys

MODEL = os.environ.get('STT_MODEL', 'medium')
LANG = os.environ.get('STT_LANG', 'he')

# The vocabulary of the conversations this actually transcribes.
#
# Override with STT_PROMPT. Worth doing: a prompt naming your own projects, tools and
# the people you talk about is the cheapest accuracy there is, and the default below is
# only a guess at somebody else's.
#
# Written as a sentence rather than a word list because that is what whisper expects —
# it is conditioning text, as if the recording had been preceded by it, so a list of
# terms reads as a strange utterance and a sentence reads as context.
PROMPT = os.environ.get('STT_PROMPT') or (
    'שיחה על פיתוח תוכנה בעברית ובאנגלית. מוזכרים בה claudegram, dabushgram, '
    'Claude Code, טלגרם, בוט, טופיק, סשן, קומיט, ריפו, גיט, פוש, לוג, API, '
    'WebSocket, Whisper, אנדרואיד, Kotlin, Node, ווינדוס, מק.'
)


#: What whisper says when there is nothing to say.
#:
#: It was trained on subtitle tracks, so fed silence it produces what sits at the end
#: of every video it ever read. These arrive looking exactly like something the user
#: said, and were being passed on as such — "תודה רבה" turned up repeatedly with no
#: one having said it.
#:
#: Matched only when a whole segment is nothing but the phrase. Somebody actually
#: thanking you mid-sentence keeps their words.
HALLUCINATIONS = {
    'תודה רבה', 'תודה', 'תודה רבה לכם', 'תודה על הצפייה', 'כתוביות',
    'הכתוביות', 'תרגום וכתוביות', 'כתוביות בעברית',
    'thank you', 'thanks for watching', 'thank you for watching',
    'subtitles by the amara.org community', 'you',
}


def bare(text):
    """A segment stripped to its bare words, for comparing against the list above."""
    return (text or '').strip().strip('.,!?׃…-" \t').lower()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        emit({'fatal': f'faster_whisper not available: {e}'})
        return 1

    # A CUDA card is worth roughly a 10x here, and plenty of hosts do not have one —
    # a Mac, a driver mismatch, a card busy elsewhere. All of those must degrade to a
    # slower answer rather than no answer at all, so the CPU path is not a fallback for
    # failures only; on some machines it is the normal one.
    model = None
    device = None
    last = 'no device tried'
    for dev, compute in (('cuda', 'float16'), ('cpu', 'int8')):
        try:
            model = WhisperModel(MODEL, device=dev, compute_type=compute)
            device = dev
            break
        except Exception as e:
            last = str(e)
    if model is None:
        emit({'fatal': f'could not load model {MODEL}: {last}'})
        return 1

    # Burn the one-time warmup here, at startup, instead of inside the first real
    # request — otherwise message one of every session pays for it.
    try:
        import numpy as np
        list(model.transcribe(np.zeros(16000, dtype='float32'), language=LANG)[0])
    except Exception:
        pass

    emit({'ready': True, 'device': device, 'model': MODEL})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception as e:
            emit({'id': None, 'error': f'bad job: {e}'})
            continue

        jid = job.get('id')
        try:
            segments, _info = model.transcribe(
                job['path'],
                language=job.get('lang') or LANG,
                beam_size=5,
                # Telegram voice notes start and end with a moment of room tone, and
                # whisper likes to invent words to fill silence. Trimming it first is
                # what keeps "..." out of the transcript.
                vad_filter=True,
                condition_on_previous_text=False,
                # Silence is where whisper invents. It was trained on subtitle tracks,
                # so given nothing to transcribe it produces what sits at the end of
                # every video it ever read: "תודה רבה", "Thank you", "כתוביות".
                # It arrives looking exactly like something the user said, and it was
                # being sent on as such.
                #
                # Raised from the 0.6 default: a segment this model is more than half
                # unsure contains speech is not worth the risk of being a sign-off.
                no_speech_threshold=0.45,
                # What this conversation is about, before it hears any of it.
                #
                # Whisper guesses a word from its sound and from what usually follows
                # what came before, and it has no idea it is listening to somebody
                # dictating about their own software in two languages at once. Proper
                # nouns it has never seen come back as whatever real words they sound
                # like — which is how a sentence about this project arrived containing
                # "טרוריזם רידלי".
                #
                # A prompt is not a filter and guarantees nothing. It tilts the guess,
                # and tilting it towards the right vocabulary is most of the difference
                # for mixed Hebrew and English technical speech.
                initial_prompt=job.get('prompt') or PROMPT,
            )
            kept = []
            for s in segments:
                # Belt as well as braces. The threshold above catches most of it, and
                # what survives is a short segment the model was confident about and
                # still invented — the sign-off phrases, which are frequent enough in
                # its training data to be produced confidently out of room tone.
                #
                # Only when the segment is nothing but the phrase. Somebody genuinely
                # saying thank you in the middle of a sentence keeps it; a whole
                # segment that is only those two words did not come from a person.
                if bare(s.text) in HALLUCINATIONS:
                    continue
                kept.append(s.text)

            emit({'id': jid, 'text': ''.join(kept).strip()})
        except Exception as e:
            emit({'id': jid, 'error': str(e)})

    return 0


if __name__ == '__main__':
    sys.exit(main())
