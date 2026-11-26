# Pack AI Web Client — Active Source

Repository: jarvisbyak-pack/matrix-ui-friday
Branch: main

This frontend is the Pack AI web client. Its visual source of truth is the local Pack AI interface in /home/akpack/Pack-AI, especially the pure OLED-black ChatGPT-style layout, compact controls, minimal typography, and responsive sidebar/chat composition.

Keep the existing authenticated web backend integration and API contracts intact. Do not copy the K20 Pro server runtime into this static frontend. The Redmi K20 Pro remains the Pack AI application server; the Raspberry Pi 5 is the controller/development workstation.

Branding in the user interface must say Pack AI. Internal compatibility identifiers may retain FridayApi and FRIDAY_CONFIG until a separately tested API migration is performed.
