const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store conversion jobs
const jobs = new Map();

// Ensure downloads directory exists
if (!fs.existsSync('downloads')) {
    fs.mkdirSync('downloads');
    console.log('Created downloads directory');
}

// Routes
app.post('/api/convert', async (req, res) => {
    try {
        const { url, quality } = req.body;
        
        // Basic YouTube URL validation
        if (!url || !(url.includes('youtube.com/') || url.includes('youtu.be/'))) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }
        
        const jobId = Date.now().toString();
        
        // Create job entry
        jobs.set(jobId, {
            id: jobId,
            status: 'processing',
            title: 'Unknown Title', // Will be updated later
            quality: quality || '192',
            progress: 0
        });
        
        // Respond immediately with job ID
        res.json({ jobId, title: 'Processing...' });
        
        // Process conversion in background
        processConversion(jobId, url, quality);
    } catch (error) {
        console.error('Conversion error:', error);
        res.status(500).json({ error: 'Failed to process video: ' + error.message });
    }
});

app.get('/api/status/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    // Create a clean object without circular references
    const cleanJob = {
        id: job.id,
        status: job.status,
        title: job.title,
        quality: job.quality,
        progress: job.progress,
        error: job.error
    };
    
    res.json(cleanJob);
});

app.get('/api/download/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    
    if (!job || job.status !== 'completed') {
        return res.status(404).json({ error: 'File not ready or not found' });
    }
    
    const filePath = path.join(__dirname, 'downloads', `${jobId}.mp3`);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    res.download(filePath, `${job.title}.mp3`, (err) => {
        if (err) {
            console.error('Download error:', err);
        }
        
        // Clean up file after download
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted file: ${filePath}`);
                }
                jobs.delete(jobId);
            } catch (e) {
                console.error('Error deleting file:', e);
            }
        }, 30000); // Keep file for 30 seconds after download
    });
});

// Get video info without downloading
app.post('/api/videoinfo', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url || !(url.includes('youtube.com/') || url.includes('youtu.be/'))) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }
        
        const result = await youtubedl(url, {
            dumpJson: true,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            addHeader: [
                'referer:youtube.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            ]
        });
        
        res.json(result);
    } catch (error) {
        console.error('Video info error:', error);
        res.status(500).json({ error: 'Failed to get video info: ' + error.message });
    }
});

function processConversion(jobId, url, quality) {
    const job = jobs.get(jobId);
    const outputPath = path.join(__dirname, 'downloads', `${jobId}.mp3`);
    
    console.log(`Starting conversion for job ${jobId}`);
    
    // Start progress simulation
    simulateProgress(jobId);
    
    // First get video info to extract title
    youtubedl(url, {
        dumpJson: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true
    })
    .then(info => {
        // Update job with title
        if (job && info.title) {
            const cleanTitle = info.title.replace(/[^\w\s]/gi, '');
            job.title = cleanTitle;
            job.status = 'processing';
            job.progress = 20; // Jump to 20% after getting info
            jobs.set(jobId, job);
        }
        
        // Now perform the conversion
        return youtubedl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: quality || 5, // 0 (best) to 9 (worst)
            output: outputPath,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            addHeader: [
                'referer:youtube.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            ]
        });
    })
    .then(() => {
        // Clear the progress interval
        if (job && job.progressIntervalId) {
            clearInterval(job.progressIntervalId);
            delete job.progressIntervalId;
        }
        
        // Mark job as completed
        if (job) {
            job.status = 'completed';
            job.progress = 100;
            jobs.set(jobId, job);
        }
        console.log(`Conversion completed for job ${jobId}`);
    })
    .catch(error => {
        console.error('Conversion error:', error);
        
        // Clear the progress interval
        if (job && job.progressIntervalId) {
            clearInterval(job.progressIntervalId);
            delete job.progressIntervalId;
        }
        
        if (job) {
            job.status = 'error';
            job.error = error.message;
            jobs.set(jobId, job);
        }
        
        // Clean up failed conversion file if it exists
        try {
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
        } catch (e) {
            console.error('Error cleaning up failed conversion:', e);
        }
    });
}

function simulateProgress(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    let progress = 5;
    job.progress = progress;
    
    // Store interval ID for cleanup (but don't include it in the JSON response)
    job.progressIntervalId = setInterval(() => {
        if (job.status === 'completed' || job.status === 'error') {
            clearInterval(job.progressIntervalId);
            delete job.progressIntervalId;
            return;
        }
        
        // Increment progress slowly, but don't go beyond 90%
        if (progress < 90) {
            progress += Math.random() * 5;
            progress = Math.min(90, progress);
            job.progress = Math.floor(progress);
            jobs.set(jobId, job);
        }
    }, 1000);
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Downloads directory: ${path.join(__dirname, 'downloads')}`);
    
    // Ensure downloads directory exists
    if (!fs.existsSync('downloads')) {
        fs.mkdirSync('downloads');
        console.log('Created downloads directory');
    }
    
    // Start cleanup interval (run every 15 minutes)
    setInterval(() => {
        console.log('Running scheduled cleanup...');
        const files = fs.readdirSync('downloads');
        const now = Date.now();
        let deletedCount = 0;
        
        files.forEach(file => {
            const filePath = path.join(__dirname, 'downloads', file);
            try {
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtimeMs;
                
                // Delete files older than 1 hour
                if (fileAge > 3600000) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    
                    // Also remove from jobs if still exists
                    const jobId = path.parse(file).name;
                    if (jobs.has(jobId)) {
                        jobs.delete(jobId);
                    }
                }
            } catch (e) {
                console.error(`Error processing file ${file}:`, e);
            }
        });
        
        if (deletedCount > 0) {
            console.log(`Cleaned up ${deletedCount} old files`);
        }
    }, 1000); // Run every 15 minutes
});