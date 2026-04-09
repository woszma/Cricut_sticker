/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Download, Loader2, Settings2, Eraser, Brush, RotateCcw, Undo2, Crop, MousePointerSquareDashed, ZoomIn, ZoomOut } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as d3 from 'd3';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

type Tool = 'pen' | 'eraser' | 'crop' | 'select' | 'none';

export default function App() {
  const [fullImage, setFullImage] = useState<HTMLImageElement | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [tolerance, setTolerance] = useState(40);
  const [offset, setOffset] = useState(20);
  const [isProcessing, setIsProcessing] = useState(false);
  const [tool, setTool] = useState<Tool>('none');
  const [brushSize, setBrushSize] = useState(30);
  const [showMask, setShowMask] = useState(true);
  const [undoStack, setUndoStack] = useState<Uint8Array[]>([]);
  const [components, setComponents] = useState<{ id: number, rect: { x: number, y: number, w: number, h: number } }[]>([]);
  const [selectedComponents, setSelectedComponents] = useState<Set<number>>(new Set());
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [visualBrushSize, setVisualBrushSize] = useState(brushSize);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const lastPanPosRef = useRef<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const finalCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const cutoutCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const contoursRef = useRef<any>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const componentMapRef = useRef<Int32Array | null>(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const currentPosRef = useRef<{ x: number; y: number } | null>(null);

  const stateRefs = useRef({ offset, tool, components, selectedComponents, showMask });
  useEffect(() => {
    stateRefs.current = { offset, tool, components, selectedComponents, showMask };
  }, [offset, tool, components, selectedComponents, showMask]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (tool === 'pen' || tool === 'eraser') {
        if (canvasRef.current) {
          const rect = canvasRef.current.getBoundingClientRect();
          if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
            setCursorPos({ x: e.clientX, y: e.clientY });
            const scaleX = rect.width / canvasRef.current.width;
            setVisualBrushSize(brushSize * scaleX);
            return;
          }
        }
      }
      setCursorPos(null);
    };
    window.addEventListener('mousemove', handleGlobalMouseMove);
    return () => window.removeEventListener('mousemove', handleGlobalMouseMove);
  }, [tool, brushSize]);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom(prev => Math.min(Math.max(0.1, prev * zoomDelta), 5));
    }
  };

  const updateUICanvas = useCallback((cropRect?: {x: number, y: number, w: number, h: number}) => {
    const { offset, tool, components, selectedComponents, showMask } = stateRefs.current;
    const uiCanvas = canvasRef.current;
    const finalCanvas = finalCanvasRef.current;
    if (!uiCanvas || !finalCanvas) return;
    const uiCtx = uiCanvas.getContext('2d');
    if (!uiCtx) return;

    uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);
    uiCtx.drawImage(finalCanvas, 0, 0);

    if (showMask && maskCanvasRef.current) {
      uiCtx.drawImage(maskCanvasRef.current, offset, offset);
    }

    if (tool === 'select') {
      components.forEach(comp => {
        const isSelected = selectedComponents.has(comp.id);
        uiCtx.strokeStyle = isSelected ? '#0ea5e9' : '#94a3b8'; // sky-500 or slate-400
        uiCtx.lineWidth = 2;
        uiCtx.setLineDash(isSelected ? [] : [5, 5]);
        uiCtx.strokeRect(comp.rect.x + offset, comp.rect.y + offset, comp.rect.w, comp.rect.h);
        
        if (isSelected) {
          uiCtx.fillStyle = 'rgba(14, 165, 233, 0.2)';
          uiCtx.fillRect(comp.rect.x + offset, comp.rect.y + offset, comp.rect.w, comp.rect.h);
        }
      });
      uiCtx.setLineDash([]);
    }

    if (cropRect) {
      uiCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      
      // Draw 4 rectangles around the crop area to create the dark overlay
      uiCtx.fillRect(0, 0, uiCanvas.width, cropRect.y + offset); // Top
      uiCtx.fillRect(0, cropRect.y + offset + cropRect.h, uiCanvas.width, uiCanvas.height - (cropRect.y + offset + cropRect.h)); // Bottom
      uiCtx.fillRect(0, cropRect.y + offset, cropRect.x + offset, cropRect.h); // Left
      uiCtx.fillRect(cropRect.x + offset + cropRect.w, cropRect.y + offset, uiCanvas.width - (cropRect.x + offset + cropRect.w), cropRect.h); // Right

      uiCtx.strokeStyle = '#0ea5e9'; // sky-500
      uiCtx.lineWidth = 2;
      uiCtx.setLineDash([5, 5]);
      uiCtx.strokeRect(cropRect.x + offset, cropRect.y + offset, cropRect.w, cropRect.h);
      uiCtx.setLineDash([]);
    }
  }, []);

  const renderFinalImage = useCallback(() => {
    if (!image || !contoursRef.current) return;
    const { offset } = stateRefs.current;
    const w = image.width;
    const h = image.height;

    const finalCanvas = finalCanvasRef.current;
    finalCanvas.width = w + offset * 2;
    finalCanvas.height = h + offset * 2;
    const fCtx = finalCanvas.getContext('2d');
    if (!fCtx) return;

    if (offset > 0) {
      fCtx.fillStyle = 'white';
      fCtx.strokeStyle = 'white';
      fCtx.lineWidth = offset * 2;
      fCtx.lineJoin = 'round';
      fCtx.lineCap = 'round';

      contoursRef.current.forEach((contour: any) => {
        contour.coordinates.forEach((polygon: any) => {
          fCtx.beginPath();
          polygon.forEach((ring: any) => {
            ring.forEach(([x, y]: [number, number], i: number) => {
              if (i === 0) fCtx.moveTo(x + offset, y + offset);
              else fCtx.lineTo(x + offset, y + offset);
            });
            fCtx.closePath();
          });
          fCtx.fill('evenodd');
          fCtx.stroke();
        });
      });
    }

    fCtx.drawImage(cutoutCanvasRef.current, offset, offset);

    if (canvasRef.current) {
      canvasRef.current.width = finalCanvas.width;
      canvasRef.current.height = finalCanvas.height;
      updateUICanvas();
    }
    setIsProcessing(false);
  }, [image, updateUICanvas]);

  const recomputeMaskData = useCallback(() => {
    if (!image || !maskRef.current) return;
    const w = image.width;
    const h = image.height;
    const mask = maskRef.current;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w; tempCanvas.height = h;
    const tCtx = tempCanvas.getContext('2d');
    if (!tCtx) return;

    const mData = tCtx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const val = mask[i] ? 255 : 0;
      mData.data[i * 4] = val;
      mData.data[i * 4 + 1] = val;
      mData.data[i * 4 + 2] = val;
      mData.data[i * 4 + 3] = 255;
    }
    tCtx.putImageData(mData, 0, 0);

    const blurCanvas = document.createElement('canvas');
    blurCanvas.width = w; blurCanvas.height = h;
    const bCtx = blurCanvas.getContext('2d', { willReadFrequently: true });
    if (!bCtx) return;
    bCtx.filter = 'blur(1.5px)';
    bCtx.drawImage(tempCanvas, 0, 0);

    const blurredData = bCtx.getImageData(0, 0, w, h).data;
    const smoothMask = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      smoothMask[i] = blurredData[i * 4] / 255;
    }

    const cutoutCanvas = cutoutCanvasRef.current;
    cutoutCanvas.width = w;
    cutoutCanvas.height = h;
    const ctx = cutoutCanvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(image, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 0; i < w * h; i++) {
        data[i * 4 + 3] = Math.min(data[i * 4 + 3], blurredData[i * 4]);
      }
      ctx.putImageData(imgData, 0, 0);
    }

    contoursRef.current = d3.contours().size([w, h]).thresholds([0.5])(smoothMask);

    const visited = new Uint8Array(w * h);
    const compMap = new Int32Array(w * h);
    compMap.fill(-1);
    const newComponents: { id: number, rect: { x: number, y: number, w: number, h: number } }[] = [];
    let compId = 0;
    const q = new Int32Array(w * h * 2);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (mask[idx] === 1 && visited[idx] === 0) {
          let minX = x, minY = y, maxX = x, maxY = y;
          let head = 0, tail = 0;
          q[tail++] = x;
          q[tail++] = y;
          visited[idx] = 1;
          
          while (head < tail) {
            const cx = q[head++];
            const cy = q[head++];
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;

            if (cx > 0) {
              const nidx = cy * w + (cx - 1);
              if (mask[nidx] === 1 && visited[nidx] === 0) { visited[nidx] = 1; q[tail++] = cx - 1; q[tail++] = cy; }
            }
            if (cx < w - 1) {
              const nidx = cy * w + (cx + 1);
              if (mask[nidx] === 1 && visited[nidx] === 0) { visited[nidx] = 1; q[tail++] = cx + 1; q[tail++] = cy; }
            }
            if (cy > 0) {
              const nidx = (cy - 1) * w + cx;
              if (mask[nidx] === 1 && visited[nidx] === 0) { visited[nidx] = 1; q[tail++] = cx; q[tail++] = cy - 1; }
            }
            if (cy < h - 1) {
              const nidx = (cy + 1) * w + cx;
              if (mask[nidx] === 1 && visited[nidx] === 0) { visited[nidx] = 1; q[tail++] = cx; q[tail++] = cy + 1; }
            }
          }
          
          if (maxX - minX > 10 && maxY - minY > 10) {
            for (let i = 0; i < tail; i += 2) {
              const cx = q[i];
              const cy = q[i + 1];
              compMap[cy * w + cx] = compId;
            }
            newComponents.push({
              id: compId++,
              rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
            });
          }
        }
      }
    }
    componentMapRef.current = compMap;
    setComponents(newComponents);
    stateRefs.current.components = newComponents;
    renderFinalImage();
  }, [image, renderFinalImage]);

  const updateMaskCanvas = useCallback(() => {
    if (!image || !maskRef.current) return;
    const w = image.width;
    const h = image.height;
    const maskCanvas = maskCanvasRef.current;
    maskCanvas.width = w;
    maskCanvas.height = h;
    const mCtx = maskCanvas.getContext('2d');
    if (!mCtx) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w; tempCanvas.height = h;
    const tCtx = tempCanvas.getContext('2d');
    if (!tCtx) return;

    const mData = tCtx.createImageData(w, h);
    const compMap = componentMapRef.current;
    const { selectedComponents } = stateRefs.current;

    for (let i = 0; i < w * h; i++) {
      const val = maskRef.current[i] ? 255 : 0;
      let isSelected = false;
      if (compMap && selectedComponents.size > 0) {
        isSelected = selectedComponents.has(compMap[i]);
      } else if (selectedComponents.size === 0) {
        // If nothing is selected, show all as red (or green? user said "instead of red mask to green mask")
        // Let's default to red, and selected becomes green.
        isSelected = false;
      }

      mData.data[i * 4] = isSelected ? 0 : 255; // Red
      mData.data[i * 4 + 1] = isSelected ? 255 : 0; // Green
      mData.data[i * 4 + 2] = 0; // Blue
      mData.data[i * 4 + 3] = val ? 120 : 0; 
    }
    tCtx.putImageData(mData, 0, 0);

    mCtx.filter = 'blur(1.5px)';
    mCtx.drawImage(tempCanvas, 0, 0);
    mCtx.filter = 'none';
  }, [image]);

  // 初始化或根據 Tolerance 重置遮罩
  const resetMask = useCallback(() => {
    if (!image) return;

    const w = image.width;
    const h = image.height;
    const tolSq = tolerance * tolerance;

    const workCanvas = document.createElement('canvas');
    const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    workCanvas.width = w;
    workCanvas.height = h;
    ctx.drawImage(image, 0, 0);

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    const visited = new Uint8Array(w * h);
    const q = new Int32Array(w * h * 2);
    let head = 0, tail = 0;

    const isBg = (x: number, y: number) => {
      const idx = (y * w + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const dist = (255 - r) * (255 - r) + (255 - g) * (255 - g) + (255 - b) * (255 - b);
      return dist <= tolSq;
    };

    const push = (x: number, y: number) => {
      const idx = y * w + x;
      if (!visited[idx]) {
        visited[idx] = 1;
        q[tail++] = x;
        q[tail++] = y;
      }
    };

    for (let x = 0; x < w; x++) {
      if (isBg(x, 0)) push(x, 0);
      if (isBg(x, h - 1)) push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      if (isBg(0, y)) push(0, y);
      if (isBg(w - 1, y)) push(w - 1, y);
    }

    while (head < tail) {
      const x = q[head++];
      const y = q[head++];
      if (x > 0 && isBg(x - 1, y)) push(x - 1, y);
      if (x < w - 1 && isBg(x + 1, y)) push(x + 1, y);
      if (y > 0 && isBg(x, y - 1)) push(x, y - 1);
      if (y < h - 1 && isBg(x, y + 1)) push(x, y + 1);
    }

    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      mask[i] = visited[i] ? 0 : 1;
    }

    maskRef.current = mask;
    setUndoStack([new Uint8Array(mask)]);
    updateMaskCanvas();
    
    setIsProcessing(true);
    setTimeout(() => {
      recomputeMaskData();
    }, 10);
  }, [image, tolerance, updateMaskCanvas, recomputeMaskData]);

  useEffect(() => {
    if (image) {
      setIsProcessing(true);
      const timer = setTimeout(() => {
        resetMask();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [image, tolerance, resetMask]);

  useEffect(() => {
    if (image && contoursRef.current) {
      const timer = setTimeout(() => {
        renderFinalImage();
      }, 16);
      return () => clearTimeout(timer);
    }
  }, [offset, renderFinalImage]);

  useEffect(() => {
    if (image) {
      updateUICanvas();
    }
  }, [showMask, updateUICanvas]);

  useEffect(() => {
    if (image) {
      updateMaskCanvas();
      updateUICanvas();
    }
  }, [selectedComponents, updateMaskCanvas, updateUICanvas]);

  const handleFileUpload = (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        setFullImage(img);
        setImage(img);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const getMousePos = (e: any) => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return null;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX - offset,
      y: (clientY - rect.top) * scaleY - offset
    };
  };

  const drawOnMask = (pos: { x: number; y: number }) => {
    if (!image || !maskRef.current || (tool !== 'pen' && tool !== 'eraser')) return;
    const mCtx = maskCanvasRef.current.getContext('2d');
    if (!mCtx) return;

    mCtx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    mCtx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    mCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
    mCtx.lineWidth = brushSize;
    mCtx.lineCap = 'round';
    mCtx.lineJoin = 'round';

    if (lastPosRef.current) {
      mCtx.beginPath();
      mCtx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
      mCtx.lineTo(pos.x, pos.y);
      mCtx.stroke();
    } else {
      mCtx.beginPath();
      mCtx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
      mCtx.fill();
    }
    lastPosRef.current = pos;

    updateUICanvas();
  };

  const handleMouseDown = (e: any) => {
    if (!image || isProcessing) return;
    
    // Middle click or space+click for panning
    if (e.button === 1 || (e.button === 0 && e.altKey) || tool === 'none') {
      isPanningRef.current = true;
      lastPanPosRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    if (tool === 'none') return;
    const pos = getMousePos(e);
    if (!pos) return;

    if (tool === 'select') {
      const clickedComp = components.find(comp => 
        pos.x >= comp.rect.x && pos.x <= comp.rect.x + comp.rect.w &&
        pos.y >= comp.rect.y && pos.y <= comp.rect.y + comp.rect.h
      );

      if (clickedComp) {
        setSelectedComponents(prev => {
          const next = new Set(prev);
          if (next.has(clickedComp.id)) next.delete(clickedComp.id);
          else next.add(clickedComp.id);
          return next;
        });
      }
      return;
    }

    isDrawingRef.current = true;
    lastPosRef.current = pos;
    currentPosRef.current = pos;
    if (tool === 'pen' || tool === 'eraser') drawOnMask(pos);
  };

  const exportSelected = async () => {
    if (selectedComponents.size === 0 || !image || !componentMapRef.current) return;
    setIsProcessing(true);
    
    // Allow UI to update
    await new Promise(resolve => setTimeout(resolve, 10));

    const zip = new JSZip();
    const selected = components.filter(c => selectedComponents.has(c.id));
    const w = image.width;
    const h = image.height;
    
    for (let i = 0; i < selected.length; i++) {
      const comp = selected[i];
      const pad = offset + 10;
      const rx = Math.max(0, comp.rect.x - pad);
      const ry = Math.max(0, comp.rect.y - pad);
      const rx2 = Math.min(w, comp.rect.x + comp.rect.w + pad);
      const ry2 = Math.min(h, comp.rect.y + comp.rect.h + pad);
      const rw = rx2 - rx;
      const rh = ry2 - ry;
      
      const regionMask = new Uint8ClampedArray(rw * rh * 4);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const globalIdx = (ry + y) * w + (rx + x);
          const localIdx = y * rw + x;
          const isComp = componentMapRef.current[globalIdx] === comp.id;
          const val = isComp ? 255 : 0;
          regionMask[localIdx * 4] = val;
          regionMask[localIdx * 4 + 1] = val;
          regionMask[localIdx * 4 + 2] = val;
          regionMask[localIdx * 4 + 3] = 255;
        }
      }

      const smallCanvas = document.createElement('canvas');
      smallCanvas.width = rw; smallCanvas.height = rh;
      const sCtx = smallCanvas.getContext('2d');
      if (!sCtx) continue;
      sCtx.putImageData(new ImageData(regionMask, rw, rh), 0, 0);

      const blurCanvas = document.createElement('canvas');
      blurCanvas.width = rw; blurCanvas.height = rh;
      const bCtx = blurCanvas.getContext('2d', { willReadFrequently: true });
      if (!bCtx) continue;
      bCtx.filter = 'blur(1.5px)';
      bCtx.drawImage(smallCanvas, 0, 0);

      const blurredData = bCtx.getImageData(0, 0, rw, rh).data;
      const smoothMask = new Float32Array(rw * rh);
      for (let j = 0; j < rw * rh; j++) {
        smoothMask[j] = blurredData[j * 4] / 255;
      }

      const contours = d3.contours().size([rw, rh]).thresholds([0.5])(smoothMask);

      const ex = Math.max(0, comp.rect.x - offset);
      const ey = Math.max(0, comp.rect.y - offset);
      const ex2 = Math.min(w, comp.rect.x + comp.rect.w + offset);
      const ey2 = Math.min(h, comp.rect.y + comp.rect.h + offset);
      const ew = ex2 - ex;
      const eh = ey2 - ey;

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = ew; exportCanvas.height = eh;
      const eCtx = exportCanvas.getContext('2d');
      if (!eCtx) continue;

      if (offset > 0) {
        eCtx.fillStyle = 'white';
        eCtx.strokeStyle = 'white';
        eCtx.lineWidth = offset * 2;
        eCtx.lineJoin = 'round';
        eCtx.lineCap = 'round';

        contours.forEach((contour: any) => {
          contour.coordinates.forEach((polygon: any) => {
            eCtx.beginPath();
            polygon.forEach((ring: any) => {
              ring.forEach(([cx, cy]: [number, number], idx: number) => {
                const px = rx + cx - ex;
                const py = ry + cy - ey;
                if (idx === 0) eCtx.moveTo(px, py);
                else eCtx.lineTo(px, py);
              });
              eCtx.closePath();
            });
            eCtx.fill('evenodd');
            eCtx.stroke();
          });
        });
      }

      const cutoutCanvas = document.createElement('canvas');
      cutoutCanvas.width = rw; cutoutCanvas.height = rh;
      const cCtx = cutoutCanvas.getContext('2d');
      if (cCtx) {
        cCtx.drawImage(image, rx, ry, rw, rh, 0, 0, rw, rh);
        const imgData = cCtx.getImageData(0, 0, rw, rh);
        for (let j = 0; j < rw * rh; j++) {
          imgData.data[j * 4 + 3] = Math.min(imgData.data[j * 4 + 3], blurredData[j * 4]);
        }
        cCtx.putImageData(imgData, 0, 0);
        eCtx.drawImage(cutoutCanvas, rx - ex, ry - ey);
      }

      const blob = await new Promise<Blob | null>(resolve => exportCanvas.toBlob(resolve, 'image/png'));
      if (blob) {
        zip.file(`sticker_${i + 1}.png`, blob);
      }
    }
    
    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, 'stickers.zip');
    setIsProcessing(false);
  };

  const handleMouseMove = (e: any) => {
    if (isPanningRef.current && lastPanPosRef.current) {
      const dx = e.clientX - lastPanPosRef.current.x;
      const dy = e.clientY - lastPanPosRef.current.y;
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      lastPanPosRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    if (!isDrawingRef.current) return;
    const pos = getMousePos(e);
    if (pos) {
      currentPosRef.current = pos;
      if (tool === 'pen' || tool === 'eraser') {
        drawOnMask(pos);
      } else if (tool === 'crop' && lastPosRef.current) {
        const startPos = lastPosRef.current;
        const x = Math.min(startPos.x, pos.x);
        const y = Math.min(startPos.y, pos.y);
        const w = Math.abs(startPos.x - pos.x);
        const h = Math.abs(startPos.y - pos.y);
        updateUICanvas({ x, y, w, h });
      }
    }
  };

  const handleMouseUp = () => {
    isPanningRef.current = false;
    lastPanPosRef.current = null;
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    if (tool === 'crop' && lastPosRef.current && currentPosRef.current && image) {
      const startPos = lastPosRef.current;
      const endPos = currentPosRef.current;
      const x = Math.max(0, Math.min(startPos.x, endPos.x));
      const y = Math.max(0, Math.min(startPos.y, endPos.y));
      const w = Math.min(image.width - x, Math.abs(startPos.x - endPos.x));
      const h = Math.min(image.height - y, Math.abs(startPos.y - endPos.y));

      if (w > 20 && h > 20) {
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = w;
        cropCanvas.height = h;
        const ctx = cropCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(image, -x, -y);
          const newImg = new Image();
          newImg.onload = () => {
            setImage(newImg);
            setTool('none');
          };
          newImg.src = cropCanvas.toDataURL();
        }
      } else {
        updateUICanvas();
      }
    } else if ((tool === 'pen' || tool === 'eraser') && image && maskRef.current) {
      // 將 Canvas 數據同步回 maskRef
      const w = image.width;
      const h = image.height;
      const mCtx = maskCanvasRef.current.getContext('2d');
      if (mCtx) {
        const mData = mCtx.getImageData(0, 0, w, h).data;
        const newMask = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          newMask[i] = mData[i * 4 + 3] > 10 ? 1 : 0;
        }
        maskRef.current = newMask;
        setUndoStack(prev => [...prev.slice(-19), new Uint8Array(newMask)]);
        setIsProcessing(true);
        setTimeout(() => {
          recomputeMaskData();
        }, 10);
      }
    }

    lastPosRef.current = null;
    currentPosRef.current = null;
  };

  const handleUndo = () => {
    if (undoStack.length <= 1) return;
    const newStack = [...undoStack];
    newStack.pop();
    const prevMask = newStack[newStack.length - 1];
    maskRef.current = new Uint8Array(prevMask);
    setUndoStack(newStack);
    updateMaskCanvas();
    setIsProcessing(true);
    setTimeout(() => {
      recomputeMaskData();
    }, 10);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row p-4 md:p-8 gap-6 font-sans text-slate-900 h-screen overflow-hidden">
      {/* Sidebar */}
      <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className="w-full md:w-80 flex-shrink-0 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col gap-6 overflow-y-auto">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-teal-600 flex items-center gap-2">✂️ Vibe Sticker</h1>
          <p className="text-sm text-slate-500 mt-1">專為 Cricut 打造的自動去背與白邊工具。</p>
        </div>

        <div className="flex flex-col gap-5">
          <label className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-teal-500 hover:bg-teal-600 text-white font-semibold rounded-xl cursor-pointer transition-colors shadow-sm">
            <Upload size={18} /> 載入圖片
            <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
          </label>

          <div className="space-y-3">
            <div className="flex justify-between text-xs font-bold text-slate-400 uppercase">去底色強度 <span className="text-teal-600">{tolerance}</span></div>
            <input type="range" min="0" max="150" value={tolerance} onChange={(e) => setTolerance(parseInt(e.target.value))} className="w-full accent-teal-500" />
          </div>

          <div className="space-y-3">
            <div className="flex justify-between text-xs font-bold text-slate-400 uppercase">白邊厚度 <span className="text-teal-600">{offset}px</span></div>
            <input type="range" min="0" max="100" value={offset} onChange={(e) => setOffset(parseInt(e.target.value))} className="w-full accent-teal-500" />
          </div>

          <div className="pt-4 border-t border-slate-100 space-y-4">
            <div className="text-xs font-bold text-slate-400 uppercase">手動修補工具</div>
            <div className="grid grid-cols-5 gap-2">
              <button onClick={() => setTool(tool === 'pen' ? 'none' : 'pen')} className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-all ${tool === 'pen' ? 'bg-teal-100 text-teal-700 ring-2 ring-teal-500' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}>
                <Brush size={18} /><span className="text-[10px] font-bold">復原</span>
              </button>
              <button onClick={() => setTool(tool === 'eraser' ? 'none' : 'eraser')} className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-all ${tool === 'eraser' ? 'bg-red-100 text-red-700 ring-2 ring-red-500' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}>
                <Eraser size={18} /><span className="text-[10px] font-bold">擦膠</span>
              </button>
              <button onClick={() => setTool(tool === 'crop' ? 'none' : 'crop')} className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-all ${tool === 'crop' ? 'bg-blue-100 text-blue-700 ring-2 ring-blue-500' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}>
                <Crop size={18} /><span className="text-[10px] font-bold">框選</span>
              </button>
              <button onClick={() => setTool(tool === 'select' ? 'none' : 'select')} className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-all ${tool === 'select' ? 'bg-purple-100 text-purple-700 ring-2 ring-purple-500' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}>
                <MousePointerSquareDashed size={18} /><span className="text-[10px] font-bold">選取</span>
              </button>
              <button onClick={handleUndo} disabled={undoStack.length <= 1} className="p-2 rounded-xl flex flex-col items-center gap-1 bg-slate-50 text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed">
                <Undo2 size={18} /><span className="text-[10px] font-bold">復原</span>
              </button>
            </div>
            {(tool === 'pen' || tool === 'eraser') && (
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] font-bold text-slate-400 uppercase">筆刷大小 <span>{brushSize}px</span></div>
                <input type="range" min="5" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} className="w-full accent-slate-400 h-1" />
              </div>
            )}
            
            <div className="flex flex-col gap-2">
              <button onClick={resetMask} className="w-full py-2 text-[11px] font-bold text-slate-400 hover:text-teal-600 flex items-center justify-center gap-2 bg-slate-50 rounded-lg hover:bg-teal-50 transition-colors"><RotateCcw size={14} /> 重置手動修改</button>
              {fullImage && image !== fullImage && (
                <button onClick={() => setImage(fullImage)} className="w-full py-2 text-[11px] font-bold text-slate-400 hover:text-blue-600 flex items-center justify-center gap-2 bg-slate-50 rounded-lg hover:bg-blue-50 transition-colors"><RotateCcw size={14} /> 還原完整圖片</button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-2">
          <div className="flex justify-between items-center bg-slate-100 rounded-xl p-2 mb-2">
            <button onClick={() => setZoom(z => Math.max(0.1, z - 0.1))} className="p-2 hover:bg-white rounded-lg text-slate-500 transition-colors"><ZoomOut size={18} /></button>
            <span className="text-xs font-bold text-slate-500">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(5, z + 0.1))} className="p-2 hover:bg-white rounded-lg text-slate-500 transition-colors"><ZoomIn size={18} /></button>
            <button onClick={() => { setZoom(1); setPan({x: 0, y: 0}); }} className="px-3 py-1 text-xs font-bold text-slate-500 hover:bg-white rounded-lg transition-colors">重置</button>
          </div>
          {selectedComponents.size > 0 && (
            <button onClick={exportSelected} disabled={isProcessing} className="py-4 bg-purple-500 hover:bg-purple-600 disabled:bg-slate-300 text-white font-bold rounded-xl shadow-md flex items-center justify-center gap-2">
              <Download size={20} /> 匯出 {selectedComponents.size} 個選取項目 (ZIP)
            </button>
          )}
          <button onClick={() => {
            const link = document.createElement('a');
            link.download = 'sticker.png';
            link.href = finalCanvasRef.current.toDataURL();
            link.click();
          }} disabled={!image || isProcessing} className="py-4 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 text-white font-bold rounded-xl shadow-md flex items-center justify-center gap-2">
            <Download size={20} /> 下載完整透明底 PNG
          </button>
        </div>
      </motion.div>

      {/* Preview Area */}
      <div className="flex-grow relative bg-slate-200 rounded-3xl border-2 border-dashed border-slate-300 overflow-hidden flex items-center justify-center" onWheel={handleWheel}>
        <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'linear-gradient(45deg, #000 25%, transparent 25%), linear-gradient(-45deg, #000 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #000 75%), linear-gradient(-45deg, transparent 75%, #000 75%)', backgroundSize: '20px 20px' }} />
        
        <AnimatePresence>
          {!image && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 z-10 text-slate-400 flex flex-col items-center justify-center gap-4 pointer-events-none"><Upload size={48} /><p className="font-medium">請上傳圖片以開始</p></motion.div>}
        </AnimatePresence>

        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center', transition: isPanningRef.current ? 'none' : 'transform 0.1s ease-out' }} className="relative flex items-center justify-center w-full h-full">
          <canvas 
            ref={canvasRef} 
            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
            onTouchStart={handleMouseDown} onTouchMove={handleMouseMove} onTouchEnd={handleMouseUp}
            className={`z-10 max-w-full max-h-full object-contain shadow-2xl ${tool === 'crop' ? 'cursor-crosshair' : tool === 'select' ? 'cursor-pointer' : tool !== 'none' ? 'cursor-none' : ''}`}
            style={{ opacity: isProcessing ? 0.5 : 1, touchAction: 'none' }}
          />
        </div>

        {/* Custom Cursor for Drawing */}
        {(tool === 'pen' || tool === 'eraser') && image && cursorPos && (
          <div 
            className="fixed pointer-events-none z-50 rounded-full border-2 border-white mix-blend-difference shadow-[0_0_4px_rgba(0,0,0,0.5)]"
            style={{
              width: `${visualBrushSize}px`,
              height: `${visualBrushSize}px`,
              left: `${cursorPos.x}px`,
              top: `${cursorPos.y}px`,
              transform: 'translate(-50%, -50%)'
            }}
          />
        )}

        {/* Floating Tool Indicator */}
        {tool !== 'none' && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 z-30 bg-white/90 backdrop-blur px-4 py-2 rounded-full shadow-lg border border-slate-200 flex items-center gap-3">
            <div className={`p-1.5 rounded-lg ${tool === 'pen' ? 'bg-teal-100 text-teal-600' : tool === 'eraser' ? 'bg-red-100 text-red-600' : tool === 'select' ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
              {tool === 'pen' ? <Brush size={16} /> : tool === 'eraser' ? <Eraser size={16} /> : tool === 'select' ? <MousePointerSquareDashed size={16} /> : <Crop size={16} />}
            </div>
            <span className="text-xs font-bold text-slate-600 uppercase tracking-widest">
              {tool === 'pen' ? '正在復原圖案' : tool === 'eraser' ? '正在擦除背景' : tool === 'select' ? '點擊選取要匯出的圖案' : '請框選要保留的範圍'}
            </span>
            <button onClick={() => setTool('none')} className="ml-2 text-slate-400 hover:text-slate-600">
              <RotateCcw size={14} />
            </button>
          </div>
        )}

        {image && (
          <button onClick={() => setShowMask(!showMask)} className={`absolute bottom-6 right-6 z-30 px-4 py-2 rounded-xl font-bold text-xs shadow-lg transition-all ${showMask ? 'bg-teal-600 text-white' : 'bg-white text-slate-600'}`}>
            {showMask ? '隱藏遮罩' : '顯示遮罩'}
          </button>
        )}

        {isProcessing && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-white/40 backdrop-blur-[2px]">
            <div className="bg-white px-6 py-4 rounded-2xl shadow-xl flex items-center gap-3 border border-slate-100">
              <Loader2 className="animate-spin text-teal-500" />
              <span className="font-bold text-slate-700">運算中...</span>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
