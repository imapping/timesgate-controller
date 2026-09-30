# Music visualizer

Listens through the microphone:
- **Lights flash to the beat:** each beat changes the backlight and/or edge light to the next
  colour in the palette, brighter when the music is louder.
- **Screens follow the music:** EQ bars across all five screens, looping in time with the detected
  tempo. The loop is re-sent when the tempo changes. The device can't show a live, frame-by-frame
  spectrum.

The mic runs only while one of these is on. Beat detection uses bass energy, so music with a clear
kick drum works best. If it misses beats or finds too many, adjust the sensitivity.
