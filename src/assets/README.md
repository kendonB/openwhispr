# Assets Directory

This directory contains app icons and other assets for OpenWhispr.

## Required Icons

For proper app packaging, you'll need the following icon files:

- `icon.icns` - macOS icon (1024x1024 recommended)
- `icon.ico` - Windows icon (256x256 recommended)
- `icon.png` - Linux icon (512x512 recommended)

## Icon Specifications

- **macOS (.icns)**: 1024x1024 pixels, PNG format converted to ICNS
- **Windows (.ico)**: 256x256 pixels, PNG format converted to ICO
- **Linux (.png)**: 512x512 pixels, PNG format

## Creating Icons

You can create these icons using:

- Online converters like https://convertio.co/
- Design tools like Figma, Sketch, or Photoshop
- Command line tools like ImageMagick

## Placeholder

Until you add your own icons, the app will use system default icons during development.

## Provider marks

- `icons/providers/elevenlabs.svg`: unmodified official ElevenLabs symbol from
  [ElevenLabs Brand Resources](https://elevenlabs.io/brand), downloaded 21 October 2026.
  [Original SVG](https://11labs-nonprd-15f22c1d.s3.eu-west-3.amazonaws.com/a2ea339b-8b5e-41bb-b706-24eda8a4c9e3/elevenlabs-symbol.svg).
  The supplied geometry and clearance are preserved; the shared monochrome filter
  displays the black mark in light mode and white in dark mode.
